import { useLayoutEffect, useRef } from 'react';
import { BatteryLow, SignalZero, WifiOff } from 'lucide-react';
import { useKernelSelector, useRuntime } from '../bridge/useKernel.ts';

export function SystemUI() {
  const { layoutRegistry } = useRuntime();
  const { battery, systemTime } = useKernelSelector((snapshot) => snapshot.hardware);
  const bar = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = bar.current;
    if (!element) return;
    const measure = () => layoutRegistry.setStatusBarHeightPx(element.getBoundingClientRect().height);
    measure();

    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, [layoutRegistry]);

  return (
    <div ref={bar} className="system-status pointer-events-none absolute inset-x-0 top-0 z-30 flex select-none items-center justify-between text-slate-200"
      data-testid="system-status">
      <time className="text-[12px] font-semibold tracking-[.04em] tabular-nums">{systemTime}</time>
      <div aria-hidden="true" className="device-island absolute left-1/2 hidden -translate-x-1/2 items-center justify-end sm:flex">
        <span className="device-camera" />
      </div>
      <div className="flex items-center gap-1.5">
        <span className="flex items-center gap-1.5 text-slate-400" aria-label="No signal">
          <SignalZero size={13} aria-hidden="true" />
          <WifiOff size={12} strokeWidth={1.7} aria-hidden="true" />
        </span>
        <span className="flex items-center gap-1 rounded-full border border-rose-400/25 bg-rose-400/10 px-1.5 py-0.5 font-mono text-[9px] leading-none text-rose-300"
          aria-label={`Battery ${battery}%`}>
          <BatteryLow size={13} strokeWidth={1.9} aria-hidden="true" />{battery}%
        </span>
      </div>
    </div>
  );
}
