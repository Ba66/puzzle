import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useRuntime } from '../bridge/useKernel.ts';

export function DeviceShell({ children }: { children: ReactNode }) {
  const { layoutRegistry } = useRuntime();
  const screen = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = screen.current;
    if (!element) return;
    const measure = () => layoutRegistry.setScreenRect(element.getBoundingClientRect());
    measure();

    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [layoutRegistry]);

  return (
    <main className="device-stage grid min-h-dvh place-items-center overflow-hidden">
      <div className="device-bezel relative" aria-label="PhoneOS">
        <div className="device-rail pointer-events-none hidden sm:block" aria-hidden="true">
          <i className="device-switch" /><i className="device-volume-up" />
          <i className="device-volume-down" /><i className="device-power" />
        </div>
        <div ref={screen} data-testid="phone-screen" className="device-screen relative isolate h-full w-full overflow-hidden">
          {children}
        </div>
      </div>
    </main>
  );
}
