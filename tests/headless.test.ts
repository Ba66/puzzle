import { describe, expect, it, vi } from 'vitest';
import type { LockScreenState } from '../src/apps/lockscreen/logic.ts';
import {
  DEFAULT_LAYOUT_METRICS, MAX_TILT_DEG, MAX_THROW_VX_ISO, MAX_THROW_VY_ISO,
} from '../src/apps/pet/brain.ts';
import type { PetInitOptions, PetState } from '../src/apps/pet/brain.ts';
import {
  EASTER_EGG_SOOTHE_LINES, INTRO_GREETING, LAND_COMPLAINT_LINES, pickNonRepeating,
  POKE_LINES, SLIDER_STUCK_LINES, SOOTHE_LINES,
} from '../src/apps/pet/dialogue.ts';
import {
  APP_MANIFESTS, createBuiltInAppDefinitions, LOCKSCREEN_APP_ID, PET_APP_ID,
} from '../src/apps/registry.ts';
import { bindGameActions, createGameRuntime } from '../src/director/actions.ts';
import type { SystemAction } from '../src/director/actions.ts';
import { initialKernelState, IntroDirector } from '../src/director/introSequence.ts';
import { Kernel } from '../src/kernel/Kernel.ts';
import type { IpcMessage, SyscallHandle, SyscallResult } from '../src/kernel/types.ts';

type Runtime = ReturnType<typeof createGameRuntime>;

const greeting = '等等……刚才那股吸力是什么？这是谁的手机？外面那个拿手指戳玻璃的……能帮我找个出口吗？';
const center = { x: 0.5, y: 0.5 };
const pointActions = ['START_DRAG_PET', 'MOVE_DRAG_PET', 'END_DRAG_PET', 'SUMMON_PET_TO'] as const;
const playerActions: SystemAction[] = [
  { type: 'POKE_PET' }, { type: 'HOLD_PET' }, { type: 'TAP_STUCK_SLIDER' },
  ...pointActions.map((type) => ({ type, payload: center })),
];

function unwrap<T>(result: SyscallResult<T>): T {
  if (!result.ok) throw new Error(result.message);
  return result.data;
}

function pet(runtime: Runtime): PetState {
  const pid = runtime.director.getSnapshot().petPid;
  const state = pid === null ? undefined : runtime.kernel.getProcessState<PetState>(pid);
  if (!state) throw new Error('Expected the Director to own a live pet process.');
  return state;
}

function lockscreen(runtime: Runtime): LockScreenState {
  const pid = runtime.director.getSnapshot().lockscreenPid;
  const state = pid === null ? undefined : runtime.kernel.getProcessState<LockScreenState>(pid);
  if (!state) throw new Error('Expected a live lockscreen process.');
  return state;
}

function actions(runtime: Runtime, ...list: SystemAction[]) {
  for (const action of list) expect(runtime.kernel.dispatch(action).accepted, action.type).toBe(true);
}

function stepTo({ kernel }: Runtime, atMs: number) {
  kernel.step(atMs - kernel.getNowMs());
}

function interactive(options: Parameters<typeof createGameRuntime>[0] = {}): Runtime {
  const runtime = createGameRuntime({ rng: () => 0.99, ...options });
  runtime.kernel.step(3800);
  expect(pet(runtime).fsm).toBe('IDLE_ROAM');
  return runtime;
}

function events(runtime: Runtime, match: string) {
  return runtime.kernel.getSnapshot().dmesg.filter(({ event }) => event === match);
}

function expectBounds({ ix, iy, x, y, layout }: PetState) {
  const side = layout.petWidthIso / 2 + 0.02;
  expect(ix).toBeGreaterThanOrEqual(side);
  expect(ix).toBeLessThanOrEqual(1 - side);
  expect(iy).toBeGreaterThanOrEqual(layout.topSafeNorm * layout.aspectRatio + layout.petHeightIso);
  expect(iy).toBeLessThanOrEqual(layout.floorYNorm * layout.aspectRatio);
  expect(x).toBe(ix);
  expect(y).toBe(iy / layout.aspectRatio);
}

function lift(runtime: Runtime, x = 0.5, heightIso = 0.50) {
  const state = pet(runtime);
  const position = { x: state.x, y: state.y };
  const payload = { x, y: state.layout.floorYNorm - heightIso / state.layout.aspectRatio };
  actions(runtime, { type: 'START_DRAG_PET', payload: position });
  runtime.kernel.step(25);
  actions(runtime, { type: 'MOVE_DRAG_PET', payload });
  runtime.kernel.step(180);
  return payload;
}

function release(runtime: Runtime, payload: { x: number; y: number }) {
  actions(runtime, { type: 'END_DRAG_PET', payload });
  return pet(runtime);
}

function until(runtime: Runtime, check: (state: PetState) => boolean, maxMs = 4000): number {
  for (let elapsedMs = 0; elapsedMs <= maxMs; elapsedMs += 5) {
    if (check(pet(runtime))) return elapsedMs;
    expectBounds(pet(runtime));
    if (elapsedMs < maxMs) runtime.kernel.step(5);
  }
  throw new Error(`Pet did not reach the expected state within ${maxMs} ms.`);
}

describe('headless boot and intro', () => {
  it('boots to one lockscreen with a read-only snapshot and can opt out of auto-start', () => {
    const runtime = createGameRuntime({ autoStartIntro: false });
    const { kernel, director } = runtime;
    expect(kernel.getSnapshot()).toMatchObject({ ...initialKernelState, nowMs: 0, inputLock: { locked: false } });
    expect(director.getSnapshot()).toMatchObject({
      flowMode: 'lockscreen', knowledgeFlags: {}, epoch: 0, introActive: false, petPid: null,
      rift: { visible: false, progress: 0, intensity: 0 },
    });
    expect(director.getStore()).not.toHaveProperty('setState');
    expect(Object.isFrozen(director.getSnapshot())).toBe(true);
    expect(Object.isFrozen(director.getSnapshot().rift)).toBe(true);
    expect(kernel.getSnapshot().processes).toMatchObject([{ appId: LOCKSCREEN_APP_ID, status: 'running' }]);
    expect(kernel.getSnapshot().surfaces).toMatchObject([{ id: 'surface:lockscreen', layer: 'system' }]);
    expect(lockscreen(runtime)).toEqual({ locked: true, tapCount: 0, stuckShakeSeq: 0, lastShakeAtMs: null, ripples: [] });
    kernel.step(900);
    expect(kernel.findActiveProcessByAppId(PET_APP_ID)).toBeUndefined();
    expect(kernel.dispatch({ type: 'POKE_PET' })).toEqual({ accepted: false, blockedBy: 'NO_HANDLER' });
    actions(runtime, { type: 'TRIGGER_INTRO_RIFT' });
    expect(director.getSnapshot()).toMatchObject({ flowMode: 'intro', epoch: 1, introElapsedMs: 0 });
    expect(kernel.getSnapshot().inputLock).toMatchObject({ locked: true, reason: 'intro_sequence', ownerId: 'director' });
  });

  it('runs the exact intro beats, rejects locked input, and preserves the greeting through handoff', () => {
    const runtime = createGameRuntime();
    const { kernel, director } = runtime;
    stepTo(runtime, 599);
    expect(director.getSnapshot().introStage).toBe('SILENT_LOCKSCREEN');
    expect(kernel.getSnapshot().processes).toHaveLength(1);
    expect(kernel.findActiveProcessByAppId(PET_APP_ID)).toBeUndefined();
    for (const action of playerActions) {
      expect(kernel.dispatch(action)).toEqual({ accepted: false, blockedBy: 'INPUT_LOCK' });
    }

    stepTo(runtime, 600);
    expect(director.getSnapshot()).toMatchObject({ introStage: 'RIFT_OPENING', rift: { visible: true } });
    expect(events(runtime, 'director.rift_open')).toHaveLength(1);
    expect(kernel.getSnapshot().processes.filter(({ appId }) => appId === PET_APP_ID)).toHaveLength(1);
    expect(kernel.getSnapshot().surfaces.filter(({ layer }) => layer === 'overlay')).toMatchObject([
      { id: 'surface:pet', pid: director.getSnapshot().petPid, layer: 'overlay' },
    ]);
    expect(pet(runtime)).toMatchObject({ fsm: 'INTRO_EMERGE', x: 0.5 });
    const emerging = pet(runtime);
    expectBounds(emerging);
    stepTo(runtime, 800);
    expect(director.getSnapshot().rift.progress).toBeCloseTo(0.5);
    expect(pet(runtime).squashX).toBeGreaterThan(emerging.squashX);

    stepTo(runtime, 1000);
    const splat = pet(runtime);
    expect(splat).toMatchObject({ fsm: 'INTRO_SPLAT', expression: 'splat', y: 0.34, squashX: 1.44, squashY: 0.56 });
    stepTo(runtime, 1190);
    expect(director.getSnapshot().rift.progress).toBeCloseTo(0.5);
    stepTo(runtime, 1380);
    expect(director.getSnapshot().rift.visible).toBe(false);
    stepTo(runtime, 1699);
    expect(pet(runtime)).toEqual(splat);
    expect(events(runtime, 'pet.land')).toHaveLength(0);

    stepTo(runtime, 1700);
    expect(pet(runtime)).toMatchObject({ fsm: 'INTRO_SLIDE', squashX: 0.92, squashY: 1.12 });
    stepTo(runtime, 2000);
    const sliding = pet(runtime);
    expect(sliding.y).toBeCloseTo(0.42);
    stepTo(runtime, 2150);
    const detached = pet(runtime);
    expect(detached.fsm).toBe('INTRO_FALL');
    expect(detached.y).toBeCloseTo(0.46);
    stepTo(runtime, 2350);
    expect(pet(runtime).vyIso).toBeGreaterThan(sliding.vyIso * 4);
    expect(pet(runtime).vyIso).toBeGreaterThan(detached.vyIso);
    stepTo(runtime, 2450);
    expect(pet(runtime)).toMatchObject({ fsm: 'INTRO_FALL', introLanded: true });
    expect(pet(runtime).vyIso).toBeLessThan(0);
    expect(pet(runtime).squashX).toBeGreaterThan(1.25);
    stepTo(runtime, 2699);
    expect(pet(runtime)).toMatchObject({ y: DEFAULT_LAYOUT_METRICS.floorYNorm, vyIso: 0 });
    expect(events(runtime, 'pet.land')).toHaveLength(1);

    stepTo(runtime, 2700);
    expect(pet(runtime)).toMatchObject({ fsm: 'INTRO_RECOVER', headShakeActive: true, expression: 'dizzy' });
    stepTo(runtime, 3079);
    expect(pet(runtime).headShakeActive).toBe(true);
    stepTo(runtime, 3080);
    expect(pet(runtime)).toMatchObject({ headShakeActive: false, expression: 'curious', lookTarget: center, bubble: null });
    stepTo(runtime, 3100);
    const opening = pet(runtime).bubble;
    expect(opening).toMatchObject({ text: greeting, tone: 'intro', remainingMs: 6500, totalMs: 6500 });
    stepTo(runtime, 3799);
    expect(kernel.getSnapshot().inputLock.locked).toBe(true);
    stepTo(runtime, 3800);
    expect(kernel.getSnapshot().inputLock.locked).toBe(false);
    expect(director.getSnapshot()).toMatchObject({ flowMode: 'interactive', introActive: false, introStage: 'COMPLETE' });
    expect(pet(runtime)).toMatchObject({ fsm: 'IDLE_ROAM', bubble: { id: opening?.id, text: greeting, remainingMs: 5800 } });
    expect(lockscreen(runtime).tapCount).toBe(0);
    expect(lockscreen(runtime).ripples).toHaveLength(0);
    expect(kernel.getSnapshot().hal.vibrationCount).toBe(0);
    expect(pet(runtime).queuedSummonTarget).toBeNull();
    stepTo(runtime, 9599);
    expect(pet(runtime).bubble?.remainingMs).toBe(1);
    stepTo(runtime, 9600);
    expect(pet(runtime).bubble).toBeNull();
  });

  it('preserves the timeline and bubble duration when a single tick crosses all intro beats', () => {
    const fine = createGameRuntime({ rng: () => 0.99 });
    for (let i = 0; i < 400; i++) fine.kernel.step(10);
    const coarse = createGameRuntime({ rng: () => 0.99 });
    coarse.kernel.step(4000);
    expect(coarse.director.getSnapshot()).toEqual(fine.director.getSnapshot());
    expect(pet(coarse)).toMatchObject({
      fsm: 'IDLE_ROAM', introLanded: true, x: pet(fine).x, y: pet(fine).y, bubble: pet(fine).bubble,
    });
    expect(events(coarse, 'pet.land')).toHaveLength(1);
    expect(events(coarse, 'director.handoff')).toHaveLength(1);
  });

  it('does not enter an intro while another owner holds the input lock', () => {
    const runtime = createGameRuntime({ autoStartIntro: false });
    const external = runtime.kernel.createSystemHandle('system-modal', ['wm:input-lock']);
    unwrap(external.wmAcquireInputLock('modal'));
    expect(runtime.kernel.dispatch({ type: 'TRIGGER_INTRO_RIFT' })).toEqual({ accepted: false, blockedBy: 'INVALID_TARGET' });
    expect(runtime.director.getSnapshot().epoch).toBe(0);
    unwrap(external.wmReleaseInputLock());
    actions(runtime, { type: 'TRIGGER_INTRO_RIFT' });
  });
});

describe('headless capabilities and lifecycle', () => {
  it('applies the real pet manifest to its kernel-issued handle and mounts the matching lockscreen manifest', () => {
    const kernel = new Kernel(initialKernelState);
    const [lockDefinition, petDefinition] = createBuiltInAppDefinitions();
    let petHandle: SyscallHandle | undefined;
    unwrap(kernel.registerApp(lockDefinition));
    unwrap(kernel.registerApp<PetState, PetInitOptions>({
      ...petDefinition,
      createProcess: (context) => {
        petHandle = context.handle;
        return petDefinition.createProcess(context);
      },
    }));
    const director = new IntroDirector(kernel);
    bindGameActions(kernel, director);
    actions({ kernel, director }, { type: 'TRIGGER_INTRO_RIFT' });
    kernel.step(3800);
    if (!petHandle) throw new Error('The pet did not receive a process handle.');
    const petProcess = kernel.findRunningProcessByAppId(PET_APP_ID);
    expect(petProcess).toMatchObject({
      grantedPermissions: ['ipc:send', 'ipc:subscribe', 'vfs:read', 'dmesg:write'],
      hiddenPermissions: ['kernel:reality-breach', 'overlay:unbounded', 'sensor:fourth-wall'],
    });
    expect(petHandle.permissions).toEqual(petProcess?.grantedPermissions);
    for (const result of [
      petHandle.procKill(director.getSnapshot().lockscreenPid!),
      petHandle.halVibrate([1]),
      petHandle.wmAcquireInputLock('forged'),
      petHandle.vfsWrite('/apps/unknown.pet/anomaly.note', 'forged'),
    ]) expect(result).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect(kernel.getSnapshot().dmesg.filter(({ level }) => level === 'sec')).toMatchObject(
      ['proc:kill', 'hal:vibrate', 'wm:input-lock', 'vfs:write'].map((permission) => ({
        source: petHandle?.ownerId, event: 'syscall.denied', detail: expect.stringContaining(permission),
      })),
    );
    expect(unwrap(petHandle.vfsList('/'))).toContainEqual({ type: 'dir', name: 'apps' });
    expect(unwrap(petHandle.vfsRead('/apps/unknown.pet/anomaly.note'))).toContain('Origin: unverified');
    expect(JSON.parse(unwrap(petHandle.vfsRead('/apps/lockscreen/manifest.json')))).toEqual(APP_MANIFESTS[0]);
    expect(kernel.getSnapshot().inputLock.locked).toBe(false);
    expect(kernel.getSnapshot().hal.vibrationCount).toBe(0);
  });

  it('vibrates through the lockscreen handle, publishes the IPC payload, and stays locked', () => {
    const onVibrate = vi.fn<(pattern: readonly number[]) => void>();
    const runtime = interactive({ onVibrate });
    const receiver = runtime.kernel.createSystemHandle('test-receiver', ['ipc:subscribe']);
    const message = vi.fn<(message: IpcMessage) => void>();
    unwrap(receiver.ipcSubscribe('lockscreen.slider_stuck', message));
    const before = lockscreen(runtime);
    actions(runtime, { type: 'TAP_STUCK_SLIDER' });
    expect(onVibrate).toHaveBeenCalledExactlyOnceWith([25, 35, 25]);
    expect(runtime.kernel.getSnapshot().hal).toMatchObject({
      vibrationCount: 1, lastVibration: { patternMs: [25, 35, 25], timestampMs: 3800 },
    });
    expect(lockscreen(runtime)).toMatchObject({ locked: true, tapCount: 1, stuckShakeSeq: 1, lastShakeAtMs: 3800 });
    expect(Object.isFrozen(lockscreen(runtime))).toBe(true);
    expect(before.tapCount).toBe(0);
    expect(message).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      senderPid: runtime.director.getSnapshot().lockscreenPid,
      payload: { tapCount: 1, shakeSeq: 1, timestampMs: 3800 },
    }));
    expect(events(runtime, 'lockscreen.slider_stuck')).toHaveLength(1);
    expect(pet(runtime)).toMatchObject({ expression: 'annoyed', lookTarget: { x: 0.5, y: 0.92 }, bubble: { tone: 'slider' } });
    expect(SLIDER_STUCK_LINES).toContain(pet(runtime).bubble?.text);
    runtime.kernel.step(650);
    expect(pet(runtime).expression).toBe('curious');
    expect(pet(runtime).bubble?.tone).toBe('slider');
  });

  it('freezes suspended motion, reactions and timers, drops IPC, and resumes without catching up', () => {
    const runtime = interactive({ rng: () => 0.01 });
    const { kernel, director } = runtime;
    const control = kernel.createSystemHandle('test-control', ['proc:control']);
    const pid = director.getSnapshot().petPid!;
    const point = lift(runtime);
    release(runtime, point);
    kernel.step(30);
    actions(runtime, { type: 'HOLD_PET' });
    const falling = pet(runtime);
    expect(falling).toMatchObject({ fsm: 'FALLING', wireframeFlashRemainingMs: 80 });
    unwrap(control.procSuspend(pid));
    expect(kernel.dispatch({ type: 'POKE_PET' })).toEqual({ accepted: false, blockedBy: 'PROCESS_SUSPENDED' });
    actions(runtime, { type: 'TAP_STUCK_SLIDER' });
    kernel.step(1800);
    expect(pet(runtime)).toBe(falling);
    unwrap(control.procResume(pid));
    expect(pet(runtime)).toBe(falling);
    kernel.step(10);
    expect(pet(runtime).iy).toBeGreaterThan(falling.iy);
    expect(pet(runtime).bubble?.remainingMs).toBe(falling.bubble!.remainingMs - 10);
    expect(pet(runtime).wireframeFlashRemainingMs).toBe(70);
    actions(runtime, { type: 'TAP_STUCK_SLIDER' }, { type: 'POKE_PET' });
    expect(pet(runtime).bubble?.tone).toBe('poke');
    actions(runtime, { type: 'TAP_STUCK_SLIDER' });
    expect(pet(runtime).bubble?.tone).toBe('slider');
    expect(pet(runtime).fsm).toBe('FALLING');
  });

  it('reconciles intro cues after a suspension that crossed the handoff', () => {
    const runtime = createGameRuntime();
    const { kernel, director } = runtime;
    const control = kernel.createSystemHandle('test-control', ['proc:control']);
    kernel.step(800);
    const pid = director.getSnapshot().petPid!;
    const before = pet(runtime);
    unwrap(control.procSuspend(pid));
    kernel.step(3000);
    expect(pet(runtime)).toBe(before);
    expect(director.getSnapshot().flowMode).toBe('interactive');
    unwrap(control.procResume(pid));
    kernel.step(0);
    expect(pet(runtime)).toMatchObject({
      fsm: 'IDLE_ROAM', introLanded: true, bubble: { text: greeting, remainingMs: 6500 },
    });
    expect(events(runtime, 'pet.land')).toHaveLength(1);
  });

  it('cancels mid-intro and mid-drag, resets the lockscreen, and never duplicates subscriptions', () => {
    const rng = vi.fn(() => 0.99);
    const runtime = createGameRuntime({ rng });
    const { kernel, director } = runtime;
    const replay = { type: 'TRIGGER_INTRO_RIFT', payload: { reason: 'debug_replay' } } as const;
    const fakeDirector = kernel.createSystemHandle('director', ['ipc:send']);
    const originalLock = director.getSnapshot().lockscreenPid;
    kernel.step(1400);
    const midIntroPid = director.getSnapshot().petPid!;
    expect(pet(runtime).fsm).toBe('INTRO_SPLAT');

    actions(runtime, replay);
    expect(kernel.getProcessState(midIntroPid)).toBeUndefined();
    expect(kernel.getSnapshot().surfaces.some(({ pid }) => pid === midIntroPid)).toBe(false);
    expect(kernel.getSnapshot().inputLock.locked).toBe(true);
    expect(director.getSnapshot()).toMatchObject({ epoch: 2, petPid: null, introElapsedMs: 0 });
    kernel.step(599);
    expect(kernel.findActiveProcessByAppId(PET_APP_ID)).toBeUndefined();
    kernel.step(1);
    const newPet = director.getSnapshot().petPid!;
    unwrap(fakeDirector.ipcPublish('director.intro_beat', { epoch: 1, beat: 'SPLAT' }));
    unwrap(fakeDirector.ipcPublish('director.intro_handoff', { epoch: 1 }));
    expect(pet(runtime).fsm).toBe('INTRO_EMERGE');
    kernel.step(3200);
    expect(kernel.getSnapshot().inputLock.locked).toBe(false);
    actions(runtime, { type: 'TAP_STUCK_SLIDER' }, { type: 'SUMMON_PET_TO', payload: { x: 0.7, y: 0.3 } });
    lift(runtime);
    expect(pet(runtime).fsm).toBe('DRAGGED');
    expect(lockscreen(runtime)).toMatchObject({ tapCount: 1, ripples: [expect.anything()] });

    actions(runtime, replay);
    expect(kernel.getProcessState(newPet)).toBeUndefined();
    for (let i = 0; i < 5; i++) actions(runtime, replay);
    expect(director.getSnapshot()).toMatchObject({ epoch: 8, lockscreenPid: originalLock, introElapsedMs: 0, petPid: null });
    expect(kernel.getSnapshot().inputLock.locked).toBe(true);
    expect(lockscreen(runtime)).toEqual({ locked: true, tapCount: 0, stuckShakeSeq: 0, lastShakeAtMs: null, ripples: [] });
    expect(kernel.dispatch({ type: 'END_DRAG_PET', payload: center })).toMatchObject({ blockedBy: 'INPUT_LOCK' });
    kernel.step(599);
    expect(kernel.getSnapshot().processes.filter(({ status }) => status !== 'terminated')).toHaveLength(1);
    kernel.step(1);
    expect(kernel.getSnapshot().processes.filter(({ status }) => status !== 'terminated')).toHaveLength(2);
    expect(kernel.getSnapshot().surfaces).toHaveLength(2);
    kernel.step(3200);
    expect(pet(runtime)).toMatchObject({ fsm: 'IDLE_ROAM', queuedSummonTarget: null, bubble: { text: greeting, id: 1 } });
    expect(kernel.getSnapshot().inputLock.locked).toBe(false);

    rng.mockClear();
    actions(runtime, { type: 'TAP_STUCK_SLIDER' });
    expect(rng).toHaveBeenCalledTimes(1);
    expect(pet(runtime).bubble).toMatchObject({ id: 2, tone: 'slider' });
    const logs = kernel.getSnapshot().dmesg;
    expect(logs.some(({ level }) => level === 'error')).toBe(false);
    expect(logs.every((entry, i) => i === 0
      || (entry.seq === logs[i - 1].seq + 1 && entry.timestampMs >= logs[i - 1].timestampMs))).toBe(true);
  });

  it('lets a replay triggered inside an old beat cancel the rest of that tick', () => {
    const runtime = createGameRuntime();
    const watcher = runtime.kernel.createSystemHandle('watcher', ['ipc:subscribe']);
    unwrap(watcher.ipcSubscribe('director.intro_beat', ({ payload }) => {
      if ((payload as { epoch: number }).epoch === 1) {
        runtime.kernel.dispatch({ type: 'TRIGGER_INTRO_RIFT', payload: { reason: 'debug_replay' } });
      }
    }));
    runtime.kernel.step(3800);
    expect(runtime.director.getSnapshot()).toMatchObject({ epoch: 2, introElapsedMs: 0, petPid: null });
    expect(runtime.kernel.getSnapshot().inputLock.locked).toBe(true);
    expect(events(runtime, 'director.handoff')).toHaveLength(0);
    runtime.kernel.step(3800);
    expect(pet(runtime).fsm).toBe('IDLE_ROAM');
    expect(events(runtime, 'director.handoff')).toHaveLength(1);
  });

  it('keeps the newest reset when replay is triggered by synchronous host callbacks', () => {
    const runtime = interactive({
      onVibrate: () => { runtime.kernel.dispatch({ type: 'TRIGGER_INTRO_RIFT' }); },
    });
    const { kernel } = runtime;
    const watcher = kernel.createSystemHandle('watcher', ['ipc:subscribe']);
    unwrap(watcher.ipcSubscribe('director.replay_reset', ({ payload }) => {
      if ((payload as { epoch: number }).epoch === 2) kernel.dispatch({ type: 'TRIGGER_INTRO_RIFT' });
    }));
    actions(runtime, { type: 'TAP_STUCK_SLIDER' });
    expect(lockscreen(runtime).tapCount).toBe(0);
    expect(runtime.director.getSnapshot()).toMatchObject({ epoch: 3, petPid: null });
    expect(kernel.getSnapshot().surfaces).toHaveLength(1);
    expect(kernel.getSnapshot().inputLock.locked).toBe(true);
    kernel.step(3800);
    expect(pet(runtime)).toMatchObject({ fsm: 'IDLE_ROAM', bubble: { text: greeting, id: 1 } });
    expect(kernel.getSnapshot().dmesg.some(({ level }) => level === 'error')).toBe(false);
  });

  it('recovers a lockscreen that was suspended or killed and recreates its missing surface on replay', () => {
    const runtime = interactive();
    const { kernel, director } = runtime;
    const host = kernel.createSystemHandle('test-host', ['proc:control', 'proc:kill', 'wm:surface']);
    const first = director.getSnapshot().lockscreenPid!;
    unwrap(host.wmDestroySurface('surface:lockscreen'));
    unwrap(host.procSuspend(first));
    actions(runtime, { type: 'TRIGGER_INTRO_RIFT' });
    expect(kernel.getSnapshot().surfaces).toMatchObject([{ pid: first, id: 'surface:lockscreen' }]);
    expect(kernel.findRunningProcessByAppId(LOCKSCREEN_APP_ID)?.pid).toBe(first);
    unwrap(host.procKill(first));
    actions(runtime, { type: 'TRIGGER_INTRO_RIFT' });
    const second = director.getSnapshot().lockscreenPid!;
    expect(second).not.toBe(first);
    expect(kernel.getSnapshot().surfaces).toMatchObject([{ pid: second, id: 'surface:lockscreen' }]);
  });
});

describe('headless pet reactions', () => {
  it('uses at least six different poke lines with no repeat, fresh expressions, and versioned expiry', () => {
    let seed = 0x52b3;
    const runtime = interactive({ rng: () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32) });
    const lines = new Set<string>();
    const poses = new Set<string>();
    for (let i = 0; i < 32; i++) {
      const old = pet(runtime);
      actions(runtime, { type: 'POKE_PET' });
      const state = pet(runtime);
      expect(state).toMatchObject({ fsm: 'POKED', squashX: 1.30, squashY: 0.72, bubble: { tone: 'poke' } });
      expect(state.bubble?.id).toBe(old.bubble!.id + 1);
      expect(state.bubble?.text).not.toBe(old.bubble?.text);
      expect(state.expression).not.toBe(old.expression);
      expect(POKE_LINES).toContain(state.bubble?.text);
      poses.add(state.expression);
      lines.add(state.bubble!.text);
      runtime.kernel.step(8);
    }
    expect(lines.size).toBeGreaterThanOrEqual(6);
    expect(poses).toEqual(new Set(['squint', 'glare', 'pout']));
    expect(pet(runtime).squashX).toBeLessThan(1.30);
    runtime.kernel.step(472);
    expect(pet(runtime).fsm).toBe('IDLE_ROAM');

    actions(runtime, { type: 'POKE_PET' });
    runtime.kernel.step(470);
    actions(runtime, { type: 'HOLD_PET' });
    const bubble = pet(runtime).bubble!;
    runtime.kernel.step(10);
    expect(pet(runtime)).toMatchObject({ fsm: 'SOOTHED', expression: 'shy', shyWobbleActive: true });
    runtime.kernel.step(1190);
    expect(pet(runtime)).toMatchObject({ fsm: 'IDLE_ROAM', shyWobbleActive: false, bubble: { id: bubble.id } });
    runtime.kernel.step(930);
    expect(pet(runtime).bubble?.id).toBe(bubble.id);
    runtime.kernel.step(170);
    expect(pet(runtime).bubble).toBeNull();
  });

  it.each([[0.01, true], [0.15, false], [0.99, false]] as const)(
    'rolls the wireframe once first at rng=%s (flash=%s)',
    (draw, flashes) => {
      const rng = vi.fn(() => 0.75).mockReturnValueOnce(draw);
      const runtime = interactive({ rng });
      expect(rng).not.toHaveBeenCalled();
      actions(runtime, { type: 'HOLD_PET' });
      expect(rng).toHaveBeenCalledTimes(2);
      expect(pet(runtime)).toMatchObject({
        fsm: 'SOOTHED', expression: 'shy', shyWobbleActive: true,
        wireframeFlashActive: flashes, wireframeFlashRemainingMs: flashes ? 80 : 0,
      });
      const first = pet(runtime).bubble!;
      expect(flashes ? EASTER_EGG_SOOTHE_LINES : SOOTHE_LINES).toContain(first.text);
      runtime.kernel.step(79);
      expect(pet(runtime).wireframeFlashRemainingMs).toBe(flashes ? 1 : 0);
      runtime.kernel.step(1);
      expect(pet(runtime)).toMatchObject({ wireframeFlashActive: false, wireframeFlashRemainingMs: 0, fsm: 'SOOTHED' });
    },
  );

  it('skips the previous dialogue index even with constant and endpoint random draws', () => {
    expect(() => pickNonRepeating([], -1, () => 0)).toThrow(RangeError);
    expect(pickNonRepeating(['only'], 0, () => 0.99)).toEqual({ text: 'only', index: 0 });
    for (const value of [0, 0.01, 0.99, 1, Number.NaN]) {
      let last = -1;
      for (let i = 0; i < 24; i++) {
        const { index, text } = pickNonRepeating(POKE_LINES, last, () => value);
        expect(index).not.toBe(last);
        expect(text).toBe(POKE_LINES[index]);
        last = index;
      }
    }
  });

  it('gently shifts after several quiet seconds without replacing an active bubble', () => {
    const runtime = interactive();
    const start = pet(runtime);
    runtime.kernel.step(4100);
    expect(pet(runtime).x).toBe(start.x);
    runtime.kernel.step(400);
    expect(Math.abs(pet(runtime).x - start.x)).toBeGreaterThan(0.005);
    expect(Math.abs(pet(runtime).x - start.x)).toBeLessThan(0.02);
    expect(pet(runtime).bubble?.id).toBe(start.bubble?.id);
    expectBounds(pet(runtime));
  });
});

describe('headless pet motion', () => {
  it('preserves grab offset, handles outside coordinates, damps stationary release, and never logs drag moves', () => {
    const runtime = interactive();
    const start = pet(runtime);
    const grab = { x: start.x - 0.08, y: start.y - 0.10 };
    actions(runtime, { type: 'START_DRAG_PET', payload: grab });
    expect(pet(runtime)).toMatchObject({ x: start.x, y: start.y, fsm: 'DRAGGED', flailing: true, expression: 'panic' });
    expect(runtime.kernel.dispatch({ type: 'START_DRAG_PET', payload: center })).toMatchObject({ blockedBy: 'INVALID_TARGET' });
    const logCount = runtime.kernel.getSnapshot().dmesg.length;
    runtime.kernel.step(20);
    actions(runtime, { type: 'MOVE_DRAG_PET', payload: { x: grab.x + 0.05, y: grab.y - 0.20 } });
    expect(pet(runtime).x).toBeCloseTo(start.x + 0.05);
    expect(pet(runtime).y).toBeCloseTo(start.y - 0.20);
    expect(pet(runtime).vxIso).toBeGreaterThan(2);
    expect(pet(runtime).tiltDeg).toBeLessThan(0);
    expect(Math.abs(pet(runtime).tiltDeg)).toBeLessThanOrEqual(MAX_TILT_DEG);
    for (const sign of [-1, 1, -1]) {
      runtime.kernel.step(20);
      actions(runtime, { type: 'MOVE_DRAG_PET', payload: { x: sign * 100, y: sign * 100 } });
      expectBounds(pet(runtime));
    }
    expect(runtime.kernel.getSnapshot().dmesg).toHaveLength(logCount);
    expect(Math.abs(pet(runtime).vxIso)).toBeGreaterThan(0.2);
    runtime.kernel.step(240);
    expect(Math.abs(pet(runtime).tiltDeg)).toBeLessThan(1);
    const falling = release(runtime, { x: -100, y: -100 });
    expect(falling.fsm).toBe('FALLING');
    expect(Math.abs(falling.vxIso)).toBeLessThan(0.05);
    expect(Math.abs(falling.vyIso)).toBeLessThan(0.05);
    expect(runtime.kernel.dispatch({ type: 'MOVE_DRAG_PET', payload: center })).toMatchObject({ blockedBy: 'INVALID_TARGET' });
    expect(runtime.kernel.dispatch({ type: 'END_DRAG_PET', payload: center })).toMatchObject({ blockedBy: 'INVALID_TARGET' });
    until(runtime, ({ fsm }) => fsm === 'IDLE_ROAM');
    expectBounds(pet(runtime));
  });

  it('throws farther than a slow drop, bounds its fling velocity, and complains once across multiple bounces', () => {
    const drop = interactive();
    const fling = interactive();
    const from = lift(drop, 0.32, 0.21);
    const windup = lift(fling, 0.24, 0.21);
    actions(drop, { type: 'MOVE_DRAG_PET', payload: from });
    actions(fling, { type: 'MOVE_DRAG_PET', payload: windup });
    for (const runtime of [drop, fling]) runtime.kernel.step(20);
    actions(drop, { type: 'MOVE_DRAG_PET', payload: from });
    actions(fling, { type: 'MOVE_DRAG_PET', payload: from });
    const still = release(drop, from);
    const moving = release(fling, from);
    expect(moving.ix).toBeCloseTo(still.ix);
    expect(still.vxIso).toBeCloseTo(0, 2);
    expect(moving.vxIso).toBe(MAX_THROW_VX_ISO);
    expect(Math.abs(moving.vyIso)).toBeLessThanOrEqual(MAX_THROW_VY_ISO);
    until(fling, ({ vxIso }) => vxIso < 0);
    expect(pet(fling).ix).toBeCloseTo(1 - pet(fling).layout.petWidthIso / 2 - 0.02);
    for (const runtime of [drop, fling]) {
      until(runtime, ({ landComplaintCount }) => landComplaintCount === 1);
      expect(pet(runtime).vyIso).toBeLessThan(0);
      expect(LAND_COMPLAINT_LINES).toContain(pet(runtime).bubble?.text);
    }
    const firstLine = pet(fling).bubble?.text;
    expect(pet(fling).ix - pet(drop).ix).toBeGreaterThan(0.35);
    for (const runtime of [drop, fling]) {
      until(runtime, ({ fsm }) => fsm === 'IDLE_ROAM');
      expect(pet(runtime).landComplaintCount).toBe(1);
      expect(events(runtime, 'pet.land')).toHaveLength(2);
    }
    expect(pet(fling).x - pet(drop).x).toBeGreaterThan(0.2);
    release(fling, lift(fling, pet(fling).x));
    until(fling, ({ landComplaintCount }) => landComplaintCount === 2);
    expect(pet(fling).bubble?.text).not.toBe(firstLine);
  });

  it('restitutes a ceiling strike and slides on a floor-level release without inventing a fall', () => {
    const runtime = interactive();
    const { layout, y } = pet(runtime);
    const top = (layout.topSafeNorm * layout.aspectRatio + layout.petHeightIso) / layout.aspectRatio;
    actions(runtime, { type: 'START_DRAG_PET', payload: { x: 0.5, y } });
    runtime.kernel.step(20);
    actions(runtime, { type: 'MOVE_DRAG_PET', payload: { x: 0.5, y: top } });
    expect(release(runtime, { x: 0.5, y: top }).vyIso).toBe(-MAX_THROW_VY_ISO);
    runtime.kernel.step(5);
    expect(pet(runtime).vyIso).toBeGreaterThan(0);
    expect(pet(runtime).y).toBeCloseTo(top);
    until(runtime, ({ fsm }) => fsm === 'IDLE_ROAM');

    actions(runtime, { type: 'START_DRAG_PET', payload: { x: 0.5, y } });
    runtime.kernel.step(20);
    actions(runtime, { type: 'MOVE_DRAG_PET', payload: { x: 0.57, y } });
    const grounded = release(runtime, { x: 0.57, y });
    expect(grounded).toMatchObject({ fsm: 'LANDING', y, vyIso: 0 });
    runtime.kernel.step(50);
    expect(pet(runtime).x).toBeGreaterThan(grounded.x);
    expect(pet(runtime).vxIso).toBeLessThan(grounded.vxIso);
    until(runtime, ({ fsm }) => fsm === 'IDLE_ROAM');
    expect(pet(runtime).landComplaintCount).toBe(1);
  });

  it('honors a queued summon after a stationary floor release and clamps an off-screen target', () => {
    const runtime = interactive();
    const position = { x: pet(runtime).x, y: pet(runtime).y };
    actions(runtime, { type: 'START_DRAG_PET', payload: position });
    actions(runtime, { type: 'SUMMON_PET_TO', payload: { x: -2, y: 1.3 } });
    expect(pet(runtime).queuedSummonTarget).toEqual({ x: 0, y: 1 });
    expect(release(runtime, position).fsm).toBe('LANDING');
    runtime.kernel.step(219);
    expect(pet(runtime).fsm).toBe('LANDING');
    runtime.kernel.step(1);
    expect(pet(runtime)).toMatchObject({ fsm: 'SUMMON_MOVE', landComplaintCount: 0, queuedSummonTarget: null });
    until(runtime, ({ fsm }) => fsm === 'IDLE_ROAM');
    expect(pet(runtime).x).toBeCloseTo(DEFAULT_LAYOUT_METRICS.petWidthIso / 2 + 0.02);
    expect(pet(runtime).lookTarget).toEqual({ x: 0, y: 1 });
  });

  it.each([false, true])('matches isotropic drop and fling trajectories across aspect ratios (fling=%s)', (fling) => {
    function simulate(aspectRatio: number) {
      const runtime = interactive({ layout: { aspectRatio } });
      const point = lift(runtime, 0.28, 0.55);
      actions(runtime, { type: 'MOVE_DRAG_PET', payload: point });
      runtime.kernel.step(30);
      const end = { x: point.x + (fling ? 0.09 : 0), y: point.y };
      actions(runtime, { type: 'MOVE_DRAG_PET', payload: end });
      const tilt = pet(runtime).tiltDeg;
      const start = release(runtime, end);
      const trace: number[][] = [];
      const floor = aspectRatio * start.layout.floorYNorm;
      const time = until(runtime, (state) => {
        trace.push([state.ix, state.iy - floor, state.vxIso, state.vyIso]);
        return state.landComplaintCount === 1;
      });
      return { tilt, trace, time, displacement: pet(runtime).ix - start.ix, iy: start.iy, floor };
    }
    const short = simulate(1.5);
    const tall = simulate(2.2);
    expect(short.iy).not.toBeCloseTo(tall.iy);
    if (fling) expect(short.tilt).toBeLessThan(-8);
    else expect(Math.abs(short.tilt)).toBeLessThan(1);
    expect(short.tilt).toBeCloseTo(tall.tilt, 9);
    expect(short.time).toBe(tall.time);
    expect(short.displacement).toBeCloseTo(tall.displacement, 9);
    expect(short.trace).toHaveLength(tall.trace.length);
    short.trace.forEach((sample, i) => sample.forEach((value, axis) => expect(value).toBeCloseTo(tall.trace[i][axis], 9)));
  });

  it('hops to the latest summon, looks at the tap, and expires immutable lockscreen ripples', () => {
    const runtime = interactive();
    const first = { x: 0.8, y: 0.39 };
    const next = { x: 0.24, y: 0.35 };
    actions(runtime, { type: 'SUMMON_PET_TO', payload: first });
    const initialRipples = lockscreen(runtime).ripples;
    expect(initialRipples).toMatchObject([{ ...first, durationMs: 650, createdAtMs: 3800 }]);
    expect(Object.isFrozen(initialRipples)).toBe(true);
    expect(Object.isFrozen(initialRipples[0])).toBe(true);
    runtime.kernel.step(100);
    expect(pet(runtime).x).toBeGreaterThan(0.5);
    expect(pet(runtime).y).toBeLessThan(DEFAULT_LAYOUT_METRICS.floorYNorm);
    const beforeRetarget = pet(runtime);
    actions(runtime, { type: 'SUMMON_PET_TO', payload: next });
    expect(pet(runtime)).toMatchObject({ fsm: 'SUMMON_MOVE', summonTarget: next, x: beforeRetarget.x, y: beforeRetarget.y });
    expect(Object.isFrozen(pet(runtime).summonTarget)).toBe(true);
    until(runtime, ({ fsm }) => fsm === 'IDLE_ROAM');
    expect(pet(runtime)).toMatchObject({ lookTarget: next, x: next.x, y: DEFAULT_LAYOUT_METRICS.floorYNorm, summonTarget: null });
    expect(pet(runtime).expression).toBe('curious');
    stepTo(runtime, 4449);
    expect(lockscreen(runtime).ripples).toHaveLength(2);
    stepTo(runtime, 4450);
    expect(lockscreen(runtime).ripples).toMatchObject([{ ...next }]);
    stepTo(runtime, 4550);
    expect(lockscreen(runtime).ripples).toHaveLength(0);
    expect(initialRipples).toHaveLength(1);
    runtime.kernel.step(1500);
    expect(pet(runtime).lookTarget).toBeNull();
  });

  it('uses the same isotropic hop height across phone layouts', () => {
    const heightAtHop = (aspectRatio: number) => {
      const runtime = interactive({ layout: { aspectRatio } });
      const floor = pet(runtime).iy;
      actions(runtime, { type: 'SUMMON_PET_TO', payload: { x: 0.85, y: 0.4 } });
      runtime.kernel.step(100);
      return floor - pet(runtime).iy;
    };
    expect(heightAtHop(1.5)).toBeGreaterThan(0.03);
    expect(heightAtHop(2.2)).toBeCloseTo(heightAtHop(1.5), 10);
  });

  it('interrupts a hop and a fall on grab, queues the last summon, and keeps slider/poke reactions out of locomotion', () => {
    const runtime = interactive();
    actions(runtime, { type: 'SUMMON_PET_TO', payload: { x: 0.80, y: 0.3 } });
    runtime.kernel.step(70);
    const hopping = pet(runtime);
    actions(runtime, { type: 'START_DRAG_PET', payload: center });
    expect(pet(runtime)).toMatchObject({ fsm: 'DRAGGED', summonTarget: null, x: hopping.x, y: hopping.y });
    const duringDrag = { x: 0.25, y: 0.42 };
    actions(runtime, { type: 'SUMMON_PET_TO', payload: duringDrag }, { type: 'TAP_STUCK_SLIDER' });
    expect(pet(runtime)).toMatchObject({
      fsm: 'DRAGGED', expression: 'panic', queuedSummonTarget: duringDrag, bubble: { tone: 'slider' },
    });
    actions(runtime, { type: 'POKE_PET' });
    expect(pet(runtime)).toMatchObject({ fsm: 'DRAGGED', bubble: { tone: 'poke' } });
    release(runtime, center);
    runtime.kernel.step(45);
    const falling = pet(runtime);
    expect(falling.fsm).toBe('FALLING');
    actions(runtime, { type: 'TAP_STUCK_SLIDER' });
    expect(pet(runtime)).toEqual({ ...falling, bubble: pet(runtime).bubble });
    expect(pet(runtime).bubble?.tone).toBe('slider');

    actions(runtime, { type: 'START_DRAG_PET', payload: center });
    expect(pet(runtime)).toMatchObject({ fsm: 'DRAGGED', x: falling.x, y: falling.y, vxIso: 0, vyIso: 0 });
    release(runtime, center);
    const latest = { x: 0.76, y: 0.31 };
    actions(runtime, { type: 'SUMMON_PET_TO', payload: latest });
    expect(pet(runtime)).toMatchObject({ fsm: 'FALLING', summonTarget: null, queuedSummonTarget: latest });
    actions(runtime, { type: 'POKE_PET' });
    expect(pet(runtime)).toMatchObject({ fsm: 'FALLING', bubble: { tone: 'poke' } });
    until(runtime, ({ fsm }) => fsm === 'SUMMON_MOVE');
    expect(pet(runtime)).toMatchObject({ summonTarget: latest, queuedSummonTarget: null, landComplaintCount: 1 });
    until(runtime, ({ fsm }) => fsm === 'IDLE_ROAM');
    expect(pet(runtime)).toMatchObject({ x: latest.x, lookTarget: latest });
    expect(lockscreen(runtime).locked).toBe(true);
  });

  it('reclamps on layout IPC, seats a grounded pet, and carries valid layout across replay', () => {
    const runtime = createGameRuntime();
    const { kernel } = runtime;
    const host = kernel.createSystemHandle('layout-host', ['ipc:send']);
    const initialLayout = { ...DEFAULT_LAYOUT_METRICS, aspectRatio: 1.5 };
    unwrap(host.ipcPublish('system.layout_changed', { layout: initialLayout }));
    kernel.step(3800);
    expect(pet(runtime).layout).toEqual(initialLayout);
    const nextLayout = { ...initialLayout, aspectRatio: 2.2, floorYNorm: 0.72, petWidthIso: 0.38 };
    unwrap(host.ipcPublish('system.layout_changed', { layout: nextLayout }));
    expect(pet(runtime)).toMatchObject({ y: 0.72, iy: 2.2 * 0.72, layout: nextLayout });
    expect(Object.isFrozen(pet(runtime).layout)).toBe(true);

    actions(runtime, { type: 'START_DRAG_PET', payload: center }, {
      type: 'MOVE_DRAG_PET', payload: { x: -2, y: -2 },
    });
    const restrictive = { ...nextLayout, aspectRatio: 1.5, topSafeNorm: 0.2, petHeightIso: 0.4, petWidthIso: 0.6 };
    unwrap(host.ipcPublish('system.layout_changed', { layout: restrictive }));
    expectBounds(pet(runtime));
    const prior = pet(runtime);
    unwrap(host.ipcPublish('system.layout_changed', { layout: { ...restrictive, petWidthIso: 30 } }));
    expect(pet(runtime)).toBe(prior);
    actions(runtime, { type: 'MOVE_DRAG_PET', payload: { x: -2, y: -2 } });
    expect(pet(runtime)).toMatchObject({ x: prior.x, y: prior.y });
    expect(kernel.dispatch({ type: 'END_DRAG_PET', payload: { x: Infinity, y: 0 } })).toMatchObject({ blockedBy: 'INVALID_TARGET' });
    actions(runtime, { type: 'TRIGGER_INTRO_RIFT' });
    kernel.step(3800);
    expect(pet(runtime).layout).toEqual(restrictive);
    expect(pet(runtime).y).toBeCloseTo(restrictive.floorYNorm, 10);
  });
});
