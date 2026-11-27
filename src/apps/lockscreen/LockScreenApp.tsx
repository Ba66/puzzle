import { useId, useLayoutEffect, useRef } from 'react';
import type { PointerEvent } from 'react';
import { BatteryWarning, ChevronRight, Lock } from 'lucide-react';
import { motion } from 'motion/react';
import { useDirectorSelector, useKernelSelector, useLockScreenState, useRuntime } from '../../bridge/useKernel.ts';
import type { DirectorSnapshot } from '../../director/introSequence.ts';

const TAP_SLOP_PX = 12;
const riftEdge = 'M2 55H24V52H40V57H61V51H76V43H93V47H106V36H125V42H137V33H153V24H167V33H179V41H195V37H211V48H225V46H239V53H256V50H272V56H297';
const riftFill = `${riftEdge}H276V60H259V58H247V63H230V61H216V69H199V66H185V74H171V86H154V77H141V70H127V73H113V65H97V67H82V60H64V62H49V56H32V59H14V57H2Z`;

function Rift({ progress, intensity }: DirectorSnapshot['rift']) {
  const id = useId();
  return (
    <div data-testid="intro-rift" aria-hidden="true" className="rift pointer-events-none absolute left-1/2 z-10 w-[88%] max-w-[350px]">
      <svg viewBox="0 0 300 112" className="block w-full overflow-visible"
        style={{ opacity: intensity, transform: `scale(${.09 + progress * .91}, ${.27 + progress * .73})` }}>
        <defs>
          <linearGradient id={`${id}-rift`}>
            <stop stopColor="#22d3ee" stopOpacity="0" />
            <stop offset=".3" stopColor="#67e8f9" />
            <stop offset=".6" stopColor="#f1ddff" />
            <stop offset=".84" stopColor="#a855f7" />
            <stop offset="1" stopColor="#a855f7" stopOpacity="0" />
          </linearGradient>
          <radialGradient id={`${id}-halo`}>
            <stop stopColor="#4fb8ff" stopOpacity=".52" />
            <stop offset=".55" stopColor="#7c3aed" stopOpacity=".20" />
            <stop offset="1" stopColor="#7c3aed" stopOpacity="0" />
          </radialGradient>
        </defs>
        <ellipse cx="151" cy="55" rx="148" ry="51" fill={`url(#${id}-halo)`} />
        <path d={riftFill} fill="#a855f7" opacity=".78" transform="translate(8 4)" className="rift-violet" />
        <path d={riftFill} fill="#22d3ee" opacity=".75" transform="translate(-7 -3)" className="rift-cyan" />
        <path d={riftFill} fill="#14102e" stroke={`url(#${id}-rift)`} strokeWidth="2.6" />
        <path d="M3 57H49V54H71V58H90V51H104V55H119V48H148V60H158V69H171V53H193V56H210V52H228V56H254V55H299"
          fill="none" stroke={`url(#${id}-rift)`} strokeWidth="2.2" className="rift-cyan" />
        <path d="M48 41H69M83 34H101M130 19H149M143 13H152M180 79H195M213 75H232M244 69H270M249 75H257"
          stroke="#55e5ff" strokeWidth="1.7" opacity=".85" />
        <path d="M83 75H101M108 84H125M124 88H148M177 21H194M202 29H222M237 36H247"
          stroke="#c28aff" strokeWidth="2" opacity=".85" />
        <path d="M116 58H135M145 46H157M148 65H163M164 44H184M173 62H187M190 61H201"
          stroke="#afc7f9" strokeWidth=".8" opacity=".53" />
      </svg>
    </div>
  );
}

interface Press {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly epoch: number;
}

const isPrimary = (event: PointerEvent) => event.isPrimary && (event.pointerType !== 'mouse' || event.button === 0);
const rattle = [0, -9, 8, -6, 4, -2, 0];

export function LockScreenApp() {
  const { kernel, director, layoutRegistry } = useRuntime();
  const { systemTime, battery } = useKernelSelector((snapshot) => snapshot.hardware);
  const lockscreen = useLockScreenState();
  const nowMs = useKernelSelector((snapshot) => lockscreen?.ripples.length ? snapshot.nowMs : 0);
  const rift = useDirectorSelector((snapshot) => snapshot.rift);
  const backgroundPress = useRef<Press | null>(null);
  const sliderPress = useRef<Press | null>(null);
  const slider = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const el = slider.current;
    const screen = el?.closest('[data-testid="phone-screen"]');
    if (!el || !screen) return;
    const background = el.closest('[data-testid="lockscreen-bg"]');
    function clearPresses() {
      const id = backgroundPress.current?.id;
      backgroundPress.current = sliderPress.current = null;
      if (id === undefined || !background?.hasPointerCapture?.(id)) return;
      try {
        background.releasePointerCapture(id);
      } catch {
        // Implicit release can race with reset or window blur.
      }
    }
    const measure = () => {
      const sliderBox = el.getBoundingClientRect();
      const screenBox = screen.getBoundingClientRect();
      if (screenBox.height > 0) layoutRegistry.setSliderTopPx(sliderBox.top - screenBox.top);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(el);
    observer?.observe(screen);
    const unsubscribe = director.subscribe((next, previous) => {
      if (next.epoch !== previous.epoch) clearPresses();
    });
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    window.addEventListener('blur', clearPresses);
    return () => {
      observer?.disconnect();
      unsubscribe();
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
      window.removeEventListener('blur', clearPresses);
    };
  }, [director, layoutRegistry]);

  function startPress(event: PointerEvent): Press | null {
    if (!isPrimary(event) || kernel.getSnapshot().inputLock.locked) return null;
    return { id: event.pointerId, x: event.clientX, y: event.clientY, epoch: director.getSnapshot().epoch };
  }

  function isTap(event: PointerEvent, press: Press) {
    return press.epoch === director.getSnapshot().epoch
      && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= TAP_SLOP_PX;
  }

  const shake = lockscreen?.stuckShakeSeq ?? 0;

  return (
    <section data-testid="lockscreen-bg" aria-label="锁屏" lang="zh-CN"
      className="lockscreen pointer-events-auto absolute inset-0 touch-none overflow-hidden select-none"
      onPointerDown={(event) => {
        if (backgroundPress.current) return;
        const press = startPress(event);
        if (!press) return;
        backgroundPress.current = press;
        try {
          event.currentTarget.setPointerCapture?.(event.pointerId);
        } catch {
          // A pressed pointer may have been interrupted before capture.
        }
      }}
      onPointerUp={(event) => {
        const press = backgroundPress.current;
        if (!press || press.id !== event.pointerId) return;
        backgroundPress.current = null;
        if (!isTap(event, press)) return;
        const point = layoutRegistry.clientToNormalized(event.clientX, event.clientY, { clamp: true });
        kernel.dispatch({ type: 'SUMMON_PET_TO', payload: point });
      }}
      onPointerCancel={(event) => {
        if (backgroundPress.current?.id === event.pointerId) backgroundPress.current = null;
      }}
      onLostPointerCapture={(event) => {
        if (backgroundPress.current?.id === event.pointerId) backgroundPress.current = null;
      }}>
      <div className="lockscreen-texture pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="lockscreen-orbit pointer-events-none absolute" aria-hidden="true" />
      <div className="lockscreen-clock pointer-events-none absolute inset-x-0 flex flex-col items-center">
        <Lock size={15} strokeWidth={1.55} className="text-slate-400" aria-hidden="true" />
        <time className="clock-digits tabular-nums">{systemTime}</time>
        <p className="flex items-center gap-2 font-mono text-[10px] font-medium tracking-[.15em] text-slate-400">
          <span>LOCKED</span>
          <span className="h-[3px] w-[3px] rounded-full bg-slate-600" aria-hidden="true" />
          <span className="inline-flex items-center gap-1.5 tracking-[.07em] text-rose-300/85">
            <BatteryWarning size={13} aria-hidden="true" />
            {battery <= 5 ? '电量严重不足' : `${battery}%`}
          </span>
        </p>
      </div>

      {rift.visible && <Rift {...rift} />}

      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        {lockscreen?.ripples.map((ripple) => {
          const age = Math.min(1, Math.max(0, (nowMs - ripple.createdAtMs) / ripple.durationMs));
          const spread = 1 - (1 - age) ** 2;
          return (
            <div key={ripple.id} className="absolute" data-testid="tap-ripple"
              style={{ left: `${ripple.x * 100}%`, top: `${ripple.y * 100}%`, opacity: (1 - age) ** 1.6 }}>
              {[0, .22, .44].map((delay) => (
                <span key={delay} className="tap-ring absolute size-14 rounded-full"
                  style={{
                    transform: `translate(-50%, -50%) scale(${.15 + Math.max(0, spread - delay) * 1.7})`,
                    opacity: Math.min(1, Math.max(0, age * 7 + .65 - delay * 4)),
                  }} />
              ))}
            </div>
          );
        })}
      </div>

      <button ref={slider} type="button" data-testid="stuck-slider" aria-label="滑动解锁"
        className="stuck-slider absolute left-1/2 block touch-none select-none rounded-full"
        onPointerDown={(event) => {
          event.stopPropagation();
          sliderPress.current ??= startPress(event);
        }}
        onPointerUp={(event) => {
          event.stopPropagation();
          const press = sliderPress.current;
          if (!press || press.id !== event.pointerId) return;
          sliderPress.current = null;
          if (isTap(event, press)) kernel.dispatch({ type: 'TAP_STUCK_SLIDER' });
        }}
        onPointerLeave={(event) => {
          if (sliderPress.current?.id === event.pointerId) sliderPress.current = null;
        }}
        onPointerCancel={(event) => {
          event.stopPropagation();
          if (sliderPress.current?.id === event.pointerId) sliderPress.current = null;
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (event.detail === 0) kernel.dispatch({ type: 'TAP_STUCK_SLIDER' });
        }}>
        <motion.span key={shake} initial={{ x: 0 }} animate={{ x: shake ? rattle : 0 }}
          transition={{ duration: .36, ease: 'easeOut' }}
          className="slider-track relative flex h-full w-full items-center rounded-full">
          {shake > 0 && (
            <motion.span initial={{ opacity: 1 }} animate={{ opacity: 0 }}
              transition={{ duration: .76, ease: 'easeOut' }}
              className="slider-jam pointer-events-none absolute inset-0 rounded-full" />
          )}
          <span className="slider-puck relative ml-[5px] grid shrink-0 place-items-center rounded-full text-slate-200">
            <ChevronRight size={20} strokeWidth={1.7} aria-hidden="true" />
          </span>
          <span className="flex flex-1 items-center justify-center gap-2 pr-2 text-[13px] font-medium tracking-[.20em] text-slate-300">
            滑动解锁 <Lock size={11} className="text-slate-500" aria-hidden="true" />
          </span>
          {shake > 0 && (
            <motion.span initial={{ opacity: 1 }} animate={{ opacity: [1, 1, 0] }}
              transition={{ duration: 1.25, times: [0, .68, 1] }}
              className="absolute inset-x-0 top-full mt-1.5 text-center text-[10px] tracking-widest text-amber-300">
              已卡死
            </motion.span>
          )}
        </motion.span>
      </button>
      <div className="home-indicator pointer-events-none absolute left-1/2 -translate-x-1/2 rounded-full" aria-hidden="true" />
    </section>
  );
}
