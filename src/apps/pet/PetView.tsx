import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useLayoutMetrics, usePetState, useRuntime, useScreenRect } from '../../bridge/useKernel.ts';
import type { PhoneRuntime } from '../../bridge/useKernel.ts';
import type { PetState } from './brain.ts';
import { PetSprite } from './PetSprite.tsx';

export const DRAG_THRESHOLD_PX = 8;
export const HOLD_DURATION_MS = 450;

type Point = { x: number; y: number };
type GesturePhase = 'IDLE' | 'PENDING' | 'DRAGGING' | 'HELD';
type PointerTarget = Pick<Element, 'setPointerCapture' | 'hasPointerCapture' | 'releasePointerCapture'>;

interface PointerPosition {
  pointerId: number;
  clientX: number;
  clientY: number;
}

interface PointerPress extends PointerPosition {
  isPrimary: boolean;
  pointerType: string;
  button: number;
  currentTarget: PointerTarget;
  stopPropagation(): void;
}

export function createPetPointerController({ kernel, director, layoutRegistry }: PhoneRuntime) {
  let activePointerId: number | null = null;
  let phase: GesturePhase = 'IDLE';
  let startClient: Point = { x: 0, y: 0 };
  let startNorm: Point = startClient;
  let lastNorm: Point = startNorm;
  let gestureEpoch = 0;
  let captureTarget: PointerTarget | null = null;
  let holdTimer: number | undefined;
  let moveFrame: number | undefined;

  const isCurrentEpoch = () => gestureEpoch === director.getSnapshot().epoch;
  const normalize = ({ clientX, clientY }: PointerPosition) =>
    layoutRegistry.clientToNormalized(clientX, clientY, { clamp: false });

  function clearHold() {
    if (holdTimer !== undefined) window.clearTimeout(holdTimer);
    holdTimer = undefined;
  }

  function clearMove() {
    if (moveFrame !== undefined) window.cancelAnimationFrame(moveFrame);
    moveFrame = undefined;
  }

  function reset() {
    clearHold();
    clearMove();
    const pointerId = activePointerId;
    const target = captureTarget;
    phase = 'IDLE';
    activePointerId = null;
    captureTarget = null;
    if (pointerId === null || !target) return;
    try {
      if (!target.hasPointerCapture || target.hasPointerCapture(pointerId)) {
        target.releasePointerCapture?.(pointerId);
      }
    } catch {
      // The browser may implicitly release capture before cancellation is delivered.
    }
  }

  function cancel() {
    if (activePointerId === null) return;
    const epoch = gestureEpoch;
    const shouldEnd = phase === 'DRAGGING' && isCurrentEpoch();
    const point = lastNorm;
    reset();
    if (shouldEnd && epoch === director.getSnapshot().epoch) {
      kernel.dispatch({ type: 'END_DRAG_PET', payload: point });
    }
  }

  return {
    getState: () => ({ activePointerId, phase, startClient, startNorm, lastNorm, gestureEpoch }),
    onPointerDown(event: PointerPress) {
      event.stopPropagation();
      if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)
        || activePointerId !== null || kernel.getSnapshot().inputLock.locked) return;

      activePointerId = event.pointerId;
      captureTarget = event.currentTarget;
      phase = 'PENDING';
      startClient = { x: event.clientX, y: event.clientY };
      startNorm = lastNorm = normalize(event);
      gestureEpoch = director.getSnapshot().epoch;
      try {
        captureTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // Capture can fail if the pointer was already interrupted.
      }

      holdTimer = window.setTimeout(() => {
        holdTimer = undefined;
        if (phase !== 'PENDING' || !isCurrentEpoch() || kernel.getSnapshot().inputLock.locked) return;
        phase = 'HELD';
        kernel.dispatch({ type: 'HOLD_PET' });
      }, HOLD_DURATION_MS);
    },
    onPointerMove(event: PointerPosition) {
      if (event.pointerId !== activePointerId) return;
      if (!isCurrentEpoch()) {
        reset();
        return;
      }
      lastNorm = normalize(event);
      if (phase === 'PENDING'
        && Math.hypot(event.clientX - startClient.x, event.clientY - startClient.y) > DRAG_THRESHOLD_PX) {
        clearHold();
        phase = 'DRAGGING';
        const result = kernel.dispatch({ type: 'START_DRAG_PET', payload: startNorm });
        if (!result.accepted || !isCurrentEpoch()) {
          reset();
          return;
        }
      }
      if (phase === 'DRAGGING' && moveFrame === undefined) {
        moveFrame = window.requestAnimationFrame(() => {
          moveFrame = undefined;
          if (phase === 'DRAGGING' && isCurrentEpoch()) kernel.dispatch({ type: 'MOVE_DRAG_PET', payload: lastNorm });
        });
      }
    },
    onPointerUp(event: PointerPosition) {
      if (event.pointerId !== activePointerId) return;
      const releasedPhase = phase;
      const epoch = gestureEpoch;
      const queuedMove = moveFrame === undefined ? undefined : lastNorm;
      const point = normalize(event);
      reset();
      if (epoch !== director.getSnapshot().epoch) return;
      if (releasedPhase === 'PENDING') kernel.dispatch({ type: 'POKE_PET' });
      if (releasedPhase === 'DRAGGING') {
        if (queuedMove) kernel.dispatch({ type: 'MOVE_DRAG_PET', payload: queuedMove });
        if (epoch === director.getSnapshot().epoch) kernel.dispatch({ type: 'END_DRAG_PET', payload: point });
      }
    },
    onPointerCancel(event: Pick<PointerPosition, 'pointerId'>) {
      if (event.pointerId === activePointerId) cancel();
    },
    onLostPointerCapture(event: Pick<PointerPosition, 'pointerId'>) {
      if (event.pointerId === activePointerId) cancel();
    },
    onBlur: cancel,
    onEpochChange() {
      if (activePointerId !== null && !isCurrentEpoch()) reset();
    },
  };
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const bodySpring = { type: 'spring', stiffness: 490, damping: 28, mass: .55 } as const;
const breath = { scaleX: [1, .988, 1], scaleY: [1, 1.023, 1] };
const resting = { scaleX: 1, scaleY: 1 };
const headShake = { rotate: [0, -13, 11, -8, 5, 0] };
const shyWobble = { rotate: [0, -4, 3.5, -2, 1, 0] };
const noWobble = { rotate: 0 };

const bubbleTints = {
  intro: 'border-cyan-300/40 shadow-cyan-400/10',
  poke: 'border-cyan-300/30 shadow-slate-950/60',
  land: 'border-indigo-300/40 shadow-slate-950/60',
  soothe: 'border-rose-300/45 shadow-rose-400/10',
  slider: 'border-amber-300/45 shadow-slate-950/60',
  easter_egg: 'border-emerald-300/60 shadow-emerald-400/20',
} satisfies Record<NonNullable<PetState['bubble']>['tone'], string>;

function useBlink() {
  const [blinking, setBlinking] = useState(false);
  useEffect(() => {
    let timer: number;
    function waitForBlink() {
      timer = window.setTimeout(() => {
        setBlinking(true);
        timer = window.setTimeout(() => {
          setBlinking(false);
          waitForBlink();
        }, 130);
      }, 3200 + Math.random() * 1800);
    }
    waitForBlink();
    return () => window.clearTimeout(timer);
  }, []);
  return blinking;
}

export function PetView() {
  const runtime = useRuntime();
  const { kernel, director, layoutRegistry } = runtime;
  const pet = usePetState();
  const screen = useScreenRect();
  const { topSafeNorm } = useLayoutMetrics();
  const [pointer, setPointer] = useState<Point>();
  const blinking = useBlink();
  const controller = useMemo(() => createPetPointerController(runtime), [runtime]);

  useLayoutEffect(() => {
    const unsubscribe = director.subscribe(controller.onEpochChange);
    window.addEventListener('blur', controller.onBlur);
    return () => {
      unsubscribe();
      window.removeEventListener('blur', controller.onBlur);
      controller.onBlur();
    };
  }, [controller, director]);

  useEffect(() => {
    function track(event: PointerEvent) {
      if (event.isPrimary) setPointer({ x: event.clientX, y: event.clientY });
    }
    window.addEventListener('pointermove', track, true);
    window.addEventListener('pointerdown', track, true);
    return () => {
      window.removeEventListener('pointermove', track, true);
      window.removeEventListener('pointerdown', track, true);
    };
  }, []);

  if (!pet) return null;

  const { x: px, y: py } = layoutRegistry.normalizedToPixel(pet.x, pet.y);
  const { width, height } = layoutRegistry.getPetSizePx();
  const gaze = pet.lookTarget ?? (pointer && layoutRegistry.clientToNormalized(pointer.x, pointer.y));
  const target = gaze && layoutRegistry.normalizedToPixel(gaze.x, gaze.y);
  const eyeOffsetX = target ? clamp((target.x - px) / (width * 1.2), -1, 1) : 0;
  const eyeOffsetY = target ? clamp((target.y - (py - height * .48)) / (height * 1.15), -1, 1) : 0;
  const emerging = pet.fsm === 'INTRO_EMERGE';
  const isIdle = pet.fsm === 'IDLE_ROAM';

  const bubbleWidth = Math.min(258, Math.max(0, screen.width - 24));
  const bubbleLeft = clamp(px - bubbleWidth / 2, 12, screen.width - 12 - bubbleWidth);
  const tailLeft = clamp(px - bubbleLeft, 14, bubbleWidth - 14);
  const bubbleBottom = screen.height - (py - height) + 9;
  const bubbleBelow = py - height - screen.height * topSafeNorm < 104 && screen.height - py > 106;

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute top-0 left-0" data-testid="pet-position"
        style={{ transform: `translate3d(${px - width / 2}px, ${py - height}px, 0)`, width, height }}>
        <button type="button" data-testid="pet-hitbox" aria-label="戳一下小桌宠"
          className="pointer-events-auto block size-full touch-none cursor-grab select-none appearance-none active:cursor-grabbing"
          onPointerDown={controller.onPointerDown} onPointerMove={controller.onPointerMove}
          onPointerUp={controller.onPointerUp} onPointerCancel={controller.onPointerCancel}
          onLostPointerCapture={controller.onLostPointerCapture}
          onKeyDown={(event) => {
            if (!event.repeat && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault();
              kernel.dispatch({ type: 'POKE_PET' });
            }
          }}>
          <motion.span className="pointer-events-none block size-full" style={{ transformOrigin: '50% 100%' }}
            initial={emerging ? { scale: .12 } : false}
            animate={{ scale: 1, scaleX: pet.squashX, scaleY: pet.squashY, rotate: pet.tiltDeg }}
            transition={bodySpring}>
            <motion.span className="block" style={{ transformOrigin: '50% 100%' }}
              animate={pet.headShakeActive ? headShake : pet.shyWobbleActive ? shyWobble : noWobble}
              transition={{ duration: pet.headShakeActive ? .34 : .86, ease: 'easeOut' }}>
              <motion.span className="block" style={{ transformOrigin: '50% 100%' }} animate={isIdle ? breath : resting}
                transition={isIdle ? { duration: 3.2, ease: 'easeInOut', repeat: Infinity } : bodySpring}>
                <PetSprite expression={pet.expression} eyeOffsetX={eyeOffsetX} eyeOffsetY={eyeOffsetY}
                  blinking={blinking} flailing={pet.flailing} wireframeFlashActive={pet.wireframeFlashActive}
                  fsm={pet.fsm} facing={pet.facing} widthPx={width} heightPx={height} />
              </motion.span>
            </motion.span>
          </motion.span>
        </button>
      </div>
      <div className="pointer-events-none absolute select-none"
        style={{ left: bubbleLeft, width: bubbleWidth, ...(bubbleBelow ? { top: py + 12 } : { bottom: bubbleBottom }) }}>
        <AnimatePresence initial={false}>
          {pet.bubble && (
            <motion.div key={pet.bubble.id} data-testid="pet-bubble" data-tone={pet.bubble.tone}
              role="status" lang="zh-CN"
              className={`pointer-events-none relative w-full select-none rounded-2xl border bg-slate-950/90 px-3.5 py-2.5 text-center text-[13px] leading-relaxed text-slate-50 shadow-lg backdrop-blur-md ${bubbleTints[pet.bubble.tone]}`}
              style={{ transformOrigin: `${tailLeft}px ${bubbleBelow ? '0%' : '100%'}` }}
              initial={{ opacity: 0, scale: .78, y: bubbleBelow ? -6 : 6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: .94, y: -4, position: 'absolute', bottom: 0, transition: { duration: .16 } }}
              transition={{ type: 'spring', stiffness: 430, damping: 27, opacity: { duration: .14 } }}>
              <span aria-hidden="true" className={`absolute size-2 -translate-x-1/2 rotate-45 border-inherit bg-slate-950
                ${bubbleBelow ? '-top-[5px] border-t border-l' : '-bottom-[5px] border-r border-b'}`}
                style={{ left: tailLeft }} />
              {pet.bubble.text}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
