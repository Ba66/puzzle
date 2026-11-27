// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LockScreenState } from '../src/apps/lockscreen/logic.ts';
import type { PetState } from '../src/apps/pet/brain.ts';
import { PET_APP_ID } from '../src/apps/registry.ts';
import { createLayoutRegistry } from '../src/bridge/layoutRegistry.ts';
import type { PhoneRuntime } from '../src/bridge/useKernel.ts';
import { createGameRuntime } from '../src/director/actions.ts';
import { PhoneOSApp } from '../src/main.tsx';

type Point = { x: number; y: number };
type PointerEventType = 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'lostpointercapture';
type Interruption = 'pointercancel' | 'lostpointercapture' | 'blur';

const phoneRect = { left: 40, top: 24, width: 360, height: 720 };
const petPointerId = 7;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
  const { left, top, width, height } = phoneRect;
  const boxes = new Map([
    ['phone-screen', new DOMRect(left, top, width, height)],
    ['system-status', new DOMRect(left, top, width, 48)],
    ['stuck-slider', new DOMRect(left + 30, top + 600, width - 60, 48)],
  ]);
  const measure = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return boxes.get(this.dataset.testid ?? '') ?? measure.call(this);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function step({ kernel }: PhoneRuntime, ms: number) {
  act(() => kernel.step(ms));
}

function elapse({ kernel }: PhoneRuntime, ms: number) {
  act(() => {
    kernel.step(ms);
    vi.advanceTimersByTime(ms);
  });
}

function frame() {
  act(() => { vi.advanceTimersToNextFrame(); });
}

function dispatchPointer(target: Element, type: PointerEventType, point: Point, init: PointerEventInit = {}) {
  fireEvent(target, new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: petPointerId,
    pointerType: 'mouse',
    isPrimary: true,
    button: type === 'pointermove' ? -1 : 0,
    buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0,
    clientX: point.x,
    clientY: point.y,
    ...init,
  }));
}

function tap(target: Element, point: Point, init?: PointerEventInit) {
  dispatchPointer(target, 'pointerdown', point, init);
  dispatchPointer(target, 'pointerup', point, init);
}

function pointerClick(target: Element, point = { x: 72, y: 56 }) {
  tap(target, point, { pointerId: 8 });
  // jsdom doesn't generate the browser's follow-up click for synthetic pointer events.
  fireEvent.click(target, { detail: 1, clientX: point.x, clientY: point.y });
}

function normalized({ x, y }: Point): Point {
  return { x: (x - phoneRect.left) / phoneRect.width, y: (y - phoneRect.top) / phoneRect.height };
}

function petState({ kernel, director }: PhoneRuntime): PetState {
  const pid = director.getSnapshot().petPid;
  const pet = pid === null ? undefined : kernel.getProcessState<PetState>(pid);
  if (!pet) throw new Error('Expected a live pet process.');
  return pet;
}

function grabPoint(runtime: PhoneRuntime): Point {
  const { x, y } = petState(runtime);
  // Use a point inside the pet, offset from its foot-center anchor on both axes.
  return { x: Math.round(phoneRect.left + x * phoneRect.width + 12), y: Math.round(phoneRect.top + y * phoneRect.height - 32) };
}

function mountPhone(rng = 0.99) {
  const layoutRegistry = createLayoutRegistry();
  const runtime = { ...createGameRuntime({ rng: () => rng }), layoutRegistry };
  const dispatch = vi.spyOn(runtime.kernel, 'dispatch');
  render(<PhoneOSApp runtime={runtime} />);
  expect(layoutRegistry.getRect()).toEqual(phoneRect);
  step(runtime, 3800);
  expect(runtime.director.getSnapshot().flowMode).toBe('interactive');
  expect(runtime.kernel.getSnapshot().inputLock.locked).toBe(false);
  expect(petState(runtime).fsm).toBe('IDLE_ROAM');

  const hitbox = screen.getByTestId('pet-hitbox');
  // Track capture on the real hitbox because jsdom implements PointerEvent but lacks pointer capture.
  const captured = new Set<number>();
  Object.assign(hitbox, {
    setPointerCapture: (id: number) => captured.add(id),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => captured.delete(id),
  });

  return { ...runtime, hitbox, actions: () => dispatch.mock.calls.map(([action]) => action) };
}

function expectBubble(runtime: PhoneRuntime, tone: NonNullable<PetState['bubble']>['tone']) {
  const { bubble } = petState(runtime);
  expect(bubble?.tone).toBe(tone);
  const element = screen.getAllByTestId('pet-bubble').find((item) => item.dataset.tone === tone);
  expect(element?.textContent).toBe(bubble?.text);
  expect(element?.classList.contains('pointer-events-none')).toBe(true);
}

function expectPositionTransform(runtime: PhoneRuntime) {
  const { x, y } = petState(runtime);
  const { width, height } = runtime.layoutRegistry.getPetSizePx();
  const transform = screen.getByTestId('pet-position').style.transform;
  const translate = /^translate3d\(([^,]+)px,\s*([^,]+)px,\s*0(?:px)?\)$/.exec(transform);
  expect(translate).not.toBeNull();
  expect(Number(translate?.[1])).toBeCloseTo(x * phoneRect.width - width / 2, 8);
  expect(Number(translate?.[2])).toBeCloseTo(y * phoneRect.height - height, 8);
}

function expectLanding(runtime: PhoneRuntime) {
  expect(petState(runtime).fsm).toBe('FALLING');
  act(() => {
    for (let elapsed = 0; elapsed < 2000 && petState(runtime).fsm !== 'LANDING'; elapsed += 20) {
      runtime.kernel.step(20);
    }
  });
  const pet = petState(runtime);
  expect(pet.fsm).toBe('LANDING');
  expect(pet.y).toBeCloseTo(pet.layout.floorYNorm);
  expect(pet.landComplaintCount).toBe(1);
  expectBubble(runtime, 'land');
  step(runtime, 350);
  expect(petState(runtime)).toMatchObject({ fsm: 'IDLE_ROAM', landComplaintCount: 1 });
}

function interrupt(target: HTMLElement, interruption: Interruption) {
  if (interruption === 'blur') {
    fireEvent(window, new Event('blur'));
    return;
  }
  if (interruption === 'lostpointercapture') target.releasePointerCapture(petPointerId);
  // A cancellation's coordinates can be unusable. The drag must use its last move instead.
  dispatchPointer(target, interruption, { x: 0, y: 0 });
}

describe('PhoneOS pet pointer gestures', () => {
  it('pokes once for a quick primary click within the drag threshold', () => {
    const runtime = mountPhone();
    const { hitbox } = runtime;
    const start = grabPoint(runtime);
    const finish = { x: start.x + 6, y: start.y - 3 };
    dispatchPointer(hitbox, 'pointerdown', start);
    expect(hitbox.hasPointerCapture(petPointerId)).toBe(true);
    elapse(runtime, 120);
    dispatchPointer(hitbox, 'pointermove', finish);
    expect(runtime.actions()).toEqual([]);
    dispatchPointer(hitbox, 'pointerup', finish);
    fireEvent.click(hitbox, { detail: 1 });
    elapse(runtime, 350);

    expect(runtime.actions()).toEqual([{ type: 'POKE_PET' }]);
    expect(petState(runtime).fsm).toBe('POKED');
    expectBubble(runtime, 'poke');
    expect(hitbox.hasPointerCapture(petPointerId)).toBe(false);
  });

  it.each([
    { name: 'a secondary mouse button', init: { button: 2, buttons: 2 } },
    { name: 'a non-primary touch pointer', init: { pointerType: 'touch', isPrimary: false } },
  ])('ignores $name', ({ init }) => {
    const runtime = mountPhone();
    const point = grabPoint(runtime);
    dispatchPointer(runtime.hitbox, 'pointerdown', point, init);
    expect(runtime.hitbox.hasPointerCapture(petPointerId)).toBe(false);
    elapse(runtime, 501);
    dispatchPointer(runtime.hitbox, 'pointerup', point, { ...init, buttons: 0 });

    expect(runtime.actions()).toEqual([]);
    expect(petState(runtime).fsm).toBe('IDLE_ROAM');
  });

  it.each([
    { rng: 0.99, tone: 'soothe' },
    { rng: 0.01, tone: 'easter_egg' },
  ] as const)('holds once and stays soothed after release with RNG $rng', ({ rng, tone }) => {
    const runtime = mountPhone(rng);
    const { hitbox } = runtime;
    const start = grabPoint(runtime);
    const jittered = { x: start.x + 8, y: start.y };
    const touch = { pointerType: 'touch' };
    const overlay = () => hitbox.querySelector('[data-part="wireframe-overlay"]');
    dispatchPointer(hitbox, 'pointerdown', start, touch);
    elapse(runtime, 200);
    dispatchPointer(hitbox, 'pointermove', jittered, touch);
    elapse(runtime, 249);
    expect(runtime.actions()).toEqual([]);
    expect(petState(runtime).fsm).toBe('IDLE_ROAM');
    expect(overlay()).toBeNull();

    elapse(runtime, 2);
    expect(runtime.actions()).toEqual([{ type: 'HOLD_PET' }]);
    expect(petState(runtime)).toMatchObject({ fsm: 'SOOTHED', expression: 'shy' });
    expect(hitbox.querySelector('[data-part="pixel-eyes"]')?.getAttribute('data-expression')).toBe('shy');
    expectBubble(runtime, tone);
    if (tone === 'easter_egg') {
      expect(overlay()).not.toBeNull();
      step(runtime, 79);
      expect(overlay()).not.toBeNull();
      step(runtime, 1);
    }
    expect(overlay()).toBeNull();

    elapse(runtime, 100);
    dispatchPointer(hitbox, 'pointerup', jittered, touch);
    expect(runtime.actions()).toEqual([{ type: 'HOLD_PET' }]);
    expect(petState(runtime)).toMatchObject({ fsm: 'SOOTHED', expression: 'shy' });
    expect(hitbox.hasPointerCapture(petPointerId)).toBe(false);
  });

  it('coalesces drag moves, preserves the grab offset, and releases once after the hold deadline', () => {
    const runtime = mountPhone();
    const { hitbox } = runtime;
    const initial = petState(runtime);
    const start = grabPoint(runtime);
    const lifted = { x: start.x + 32, y: start.y - 68 };
    const held = { x: start.x + 46, y: start.y - 80 };
    const release = { x: held.x + 1, y: held.y - 1 };
    expectPositionTransform(runtime);
    const initialTransform = screen.getByTestId('pet-position').style.transform;

    dispatchPointer(hitbox, 'pointerdown', start);
    elapse(runtime, 30);
    dispatchPointer(hitbox, 'pointermove', { x: start.x + 24, y: start.y - 50 });
    expect(runtime.actions()).toEqual([{ type: 'START_DRAG_PET', payload: normalized(start) }]);
    expect(petState(runtime)).toMatchObject({ fsm: 'DRAGGED', x: initial.x, y: initial.y });
    expect(screen.getByTestId('pet-position').style.transform).toBe(initialTransform);

    dispatchPointer(hitbox, 'pointermove', lifted);
    expect(runtime.actions()).toHaveLength(1);
    frame();
    expect(runtime.actions().slice(1)).toEqual([{ type: 'MOVE_DRAG_PET', payload: normalized(lifted) }]);
    expect(petState(runtime).x).toBeCloseTo(initial.x + (lifted.x - start.x) / phoneRect.width, 12);
    expect(petState(runtime).y).toBeCloseTo(initial.y + (lifted.y - start.y) / phoneRect.height, 12);
    expectPositionTransform(runtime);
    expect(screen.getByTestId('pet-position').style.transform).not.toBe(initialTransform);

    elapse(runtime, 501);
    expect(petState(runtime).fsm).toBe('DRAGGED');
    expect(runtime.actions()).toHaveLength(2);
    dispatchPointer(hitbox, 'pointermove', held);
    expect(runtime.actions()).toHaveLength(2);
    dispatchPointer(hitbox, 'pointerup', release);
    frame();
    expect(runtime.actions()).toEqual([
      { type: 'START_DRAG_PET', payload: normalized(start) },
      { type: 'MOVE_DRAG_PET', payload: normalized(lifted) },
      { type: 'MOVE_DRAG_PET', payload: normalized(held) },
      { type: 'END_DRAG_PET', payload: normalized(release) },
    ]);
    expect(hitbox.hasPointerCapture(petPointerId)).toBe(false);
    expectPositionTransform(runtime);
    expectLanding(runtime);
  });

  it.each(['pointercancel', 'lostpointercapture', 'blur'] as const)(
    'releases a drag at the last valid coordinates on %s and accepts a new tap', (interruption) => {
      const runtime = mountPhone();
      const { hitbox } = runtime;
      const start = grabPoint(runtime);
      const lifted = { x: start.x + 24, y: start.y - 50 };
      const latest = { x: start.x + 36, y: start.y - 70 };
      dispatchPointer(hitbox, 'pointerdown', start);
      dispatchPointer(hitbox, 'pointermove', lifted);
      frame();
      expect(petState(runtime).fsm).toBe('DRAGGED');
      expect(hitbox.hasPointerCapture(petPointerId)).toBe(true);
      dispatchPointer(hitbox, 'pointermove', latest);
      expect(runtime.actions()).toHaveLength(2);

      interrupt(hitbox, interruption);
      expect(hitbox.hasPointerCapture(petPointerId)).toBe(false);
      dispatchPointer(hitbox, 'lostpointercapture', { x: 0, y: 0 });
      dispatchPointer(hitbox, 'pointerup', { x: 0, y: 0 });
      expectLanding(runtime);
      elapse(runtime, 501);
      // The extra interruption, stale release, queued move and old hold timer cannot dispatch.
      const dragActions = [
        { type: 'START_DRAG_PET', payload: normalized(start) },
        { type: 'MOVE_DRAG_PET', payload: normalized(lifted) },
        { type: 'END_DRAG_PET', payload: normalized(latest) },
      ];
      expect(runtime.actions()).toEqual(dragActions);
      expect(petState(runtime).landComplaintCount).toBe(1);

      tap(hitbox, grabPoint(runtime));
      expect(runtime.actions()).toEqual([...dragActions, { type: 'POKE_PET' }]);
      expect(petState(runtime).fsm).toBe('POKED');
      expectBubble(runtime, 'poke');
    },
  );

  it.each(['pointercancel', 'blur'] as const)('clears a pending press on %s without holding or poking', (interruption) => {
    const runtime = mountPhone();
    const { hitbox } = runtime;
    const start = grabPoint(runtime);
    dispatchPointer(hitbox, 'pointerdown', start);
    elapse(runtime, 100);
    expect(hitbox.hasPointerCapture(petPointerId)).toBe(true);
    interrupt(hitbox, interruption);
    expect(hitbox.hasPointerCapture(petPointerId)).toBe(false);
    elapse(runtime, 501);
    dispatchPointer(hitbox, 'pointerup', start);

    expect(runtime.actions()).toEqual([]);
    expect(petState(runtime).fsm).toBe('IDLE_ROAM');
    tap(hitbox, start);
    expect(runtime.actions()).toEqual([{ type: 'POKE_PET' }]);
  });
});

describe('PhoneOS replay during pointer input', () => {
  it.each(['during the locked intro', 'after the next handoff'] as const)(
    'ignores an old drag released %s', (releaseTiming) => {
      const runtime = mountPhone();
      const { hitbox, director, kernel } = runtime;
      const { epoch, petPid } = director.getSnapshot();
      const start = grabPoint(runtime);
      const lifted = { x: start.x + 24, y: start.y - 50 };
      const touch = { pointerType: 'touch' };
      dispatchPointer(hitbox, 'pointerdown', start, touch);
      dispatchPointer(hitbox, 'pointermove', lifted, touch);
      expect(petState(runtime).fsm).toBe('DRAGGED');
      expect(hitbox.hasPointerCapture(petPointerId)).toBe(true);

      pointerClick(screen.getByTestId('debug-toggle'));
      expect(screen.getByTestId('debug-drawer')).toBeDefined();
      pointerClick(screen.getByTestId('debug-replay-btn'));
      expect(director.getSnapshot()).toMatchObject({ epoch: epoch + 1, introStage: 'SILENT_LOCKSCREEN', petPid: null });
      expect(kernel.getSnapshot().inputLock.locked).toBe(true);
      expect(kernel.getSnapshot().processes).toContainEqual(expect.objectContaining({ pid: petPid, appId: PET_APP_ID, status: 'terminated' }));
      expect(hitbox.hasPointerCapture(petPointerId)).toBe(false);
      expect(screen.queryByTestId('pet-hitbox')).toBeNull();
      frame();

      step(runtime, 600);
      const newHitbox = screen.getByTestId('pet-hitbox');
      expect(newHitbox).not.toBe(hitbox);
      expect(director.getSnapshot().petPid).not.toBe(petPid);
      expect(kernel.getSnapshot().inputLock.locked).toBe(true);
      dispatchPointer(newHitbox, 'pointermove', lifted, touch);
      if (releaseTiming === 'during the locked intro') dispatchPointer(newHitbox, 'pointerup', lifted, touch);

      step(runtime, 3200);
      expect(kernel.getSnapshot().inputLock.locked).toBe(false);
      if (releaseTiming === 'after the next handoff') {
        dispatchPointer(newHitbox, 'pointermove', lifted, touch);
        dispatchPointer(newHitbox, 'pointerup', lifted, touch);
      }
      elapse(runtime, 501);
      const replayActions = [
        { type: 'START_DRAG_PET', payload: normalized(start) },
        { type: 'TRIGGER_INTRO_RIFT', payload: { reason: 'debug_replay' } },
      ];
      expect(runtime.actions()).toEqual(replayActions);
      expect(petState(runtime).fsm).toBe('IDLE_ROAM');
      tap(newHitbox, grabPoint(runtime), touch);
      expect(runtime.actions()).toEqual([...replayActions, { type: 'POKE_PET' }]);
      expect(petState(runtime).fsm).toBe('POKED');
    },
  );
});

describe('PhoneOS pointer hit areas', () => {
  it('rattles the stuck slider once and shows the pet complaint without summoning', () => {
    const runtime = mountPhone();
    const slider = screen.getByTestId('stuck-slider');
    expect(within(slider).queryByText('已卡死')).toBeNull();
    pointerClick(slider, { x: 220, y: 644 });

    expect(runtime.actions()).toEqual([{ type: 'TAP_STUCK_SLIDER' }]);
    const pid = runtime.director.getSnapshot().lockscreenPid;
    expect(pid === null ? undefined : runtime.kernel.getProcessState<LockScreenState>(pid)).toMatchObject(
      { tapCount: 1, stuckShakeSeq: 1, locked: true, ripples: [] },
    );
    expect(runtime.kernel.getSnapshot().hal.vibrationCount).toBe(1);
    expect(within(slider).getByText('已卡死')).toBeDefined();
    expectBubble(runtime, 'slider');
    expect(screen.queryByTestId('tap-ripple')).toBeNull();
  });

  it('summons from empty lockscreen space and draws a ripple at the normalized tap point', () => {
    const runtime = mountPhone();
    const background = screen.getByTestId('lockscreen-bg');
    for (const area of [background, runtime.hitbox]) {
      expect(area.classList.contains('touch-none')).toBe(true);
      expect(area.classList.contains('select-none')).toBe(true);
    }
    expectBubble(runtime, 'intro');

    tap(background, { x: 310, y: 312 });
    const target = { x: 0.75, y: 0.4 };
    expect(runtime.actions()).toEqual([{ type: 'SUMMON_PET_TO', payload: target }]);
    expect(petState(runtime)).toMatchObject({ fsm: 'SUMMON_MOVE', summonTarget: target });
    const ripple = screen.getByTestId('tap-ripple');
    expect(ripple.style.left).toBe('75%');
    expect(ripple.style.top).toBe('40%');
  });

  it('opens Processes, previews a VFS file, and inspects dmesg without summoning', () => {
    const runtime = mountPhone();
    const toggle = screen.getByTestId('debug-toggle');
    pointerClick(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const drawer = screen.getByTestId('debug-drawer');
    const panel = within(drawer);
    pointerClick(drawer);
    pointerClick(panel.getByRole('button', { name: 'Processes' }));
    const table = within(panel.getByRole('table', { name: 'Process table' }));
    const petRow = table.getByRole('row', { name: /unknown\.pet/ });
    pointerClick(within(petRow).getByText('running'));
    expect(runtime.actions()).toEqual([]);

    pointerClick(panel.getByRole('button', { name: 'VFS' }));
    const tree = within(panel.getByLabelText('VFS tree'));
    pointerClick(tree.getByText('system'));
    pointerClick(tree.getByRole('button', { name: 'os.conf' }));
    const file = panel.getByTestId('debug-vfs-file');
    expect(within(file).getByRole('heading', { name: '/system/os.conf' })).toBeDefined();
    const contents = within(file).getByText(/clock=logical/);
    pointerClick(contents);
    expect(runtime.actions()).toEqual([]);

    pointerClick(panel.getByRole('button', { name: 'dmesg' }));
    const log = within(panel.getByRole('list', { name: 'Kernel log, newest first' }));
    pointerClick(log.getByText('director.handoff'));
    expect(log.getByText('director.intro_start')).toBeDefined();
    pointerClick(toggle);
    expect(screen.queryByTestId('debug-drawer')).toBeNull();
    expect(runtime.actions()).toEqual([]);
    expect(screen.queryByTestId('tap-ripple')).toBeNull();
    expect(petState(runtime).fsm).toBe('IDLE_ROAM');
  });
});
