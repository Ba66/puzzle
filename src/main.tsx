import { StrictMode, useEffect, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { createLayoutRegistry } from './bridge/layoutRegistry.ts';
import { RuntimeProvider } from './bridge/useKernel.ts';
import type { PhoneRuntime } from './bridge/useKernel.ts';
import { createGameRuntime } from './director/actions.ts';
import type { Kernel } from './kernel/Kernel.ts';
import { DebugDrawer } from './shell/DebugDrawer.tsx';
import { DeviceShell } from './shell/DeviceShell.tsx';
import { SystemUI } from './shell/SystemUI.tsx';
import { WindowHost } from './shell/WindowHost.tsx';
import './index.css';

const STEP_MS = 1000 / 60;
const MAX_STEPS_PER_FRAME = 4;
const BACKGROUND_GAP_MS = 250;

export function PhoneOSApp({ runtime }: { runtime: PhoneRuntime }) {
  const { kernel, layoutRegistry } = runtime;
  useLayoutEffect(() => {
    const handle = kernel.createSystemHandle('layout-bridge', ['ipc:send']);
    let currentLayout = layoutRegistry.getLayoutMetrics();
    handle.ipcPublish('system.layout_changed', { layout: currentLayout });
    return layoutRegistry.subscribe((layout) => {
      if (layout === currentLayout) return;
      currentLayout = layout;
      handle.ipcPublish('system.layout_changed', { layout });
    });
  }, [kernel, layoutRegistry]);

  return (
    <RuntimeProvider runtime={runtime}>
      <DeviceShell>
        <SystemUI />
        <WindowHost />
      </DeviceShell>
      <DebugDrawer />
    </RuntimeProvider>
  );
}

function driveClock(kernel: Kernel) {
  let previousFrameMs: number | undefined;
  let accumulatorMs = 0;
  let frameId = window.requestAnimationFrame(advanceFrame);

  function resetClock() {
    previousFrameMs = undefined;
    accumulatorMs = 0;
  }

  function advanceFrame(frameMs: number) {
    const delta = previousFrameMs === undefined ? 0 : frameMs - previousFrameMs;
    if (delta > BACKGROUND_GAP_MS) accumulatorMs = 0;
    else accumulatorMs = Math.min(accumulatorMs + Math.max(0, delta), MAX_STEPS_PER_FRAME * STEP_MS);

    previousFrameMs = frameMs;
    for (let steps = 0; steps < MAX_STEPS_PER_FRAME && accumulatorMs + 1e-7 >= STEP_MS; steps++) {
      kernel.step(STEP_MS);
      accumulatorMs = Math.max(0, accumulatorMs - STEP_MS);
    }
    frameId = window.requestAnimationFrame(advanceFrame);
  }

  document.addEventListener('visibilitychange', resetClock);
  return () => {
    window.cancelAnimationFrame(frameId);
    document.removeEventListener('visibilitychange', resetClock);
  };
}

function BrowserPhone({ runtime }: { runtime: PhoneRuntime }) {
  useEffect(() => {
    if (runtime.director.getSnapshot().epoch === 0) {
      runtime.kernel.dispatch({ type: 'TRIGGER_INTRO_RIFT', payload: { reason: 'boot' } });
    }
    return driveClock(runtime.kernel);
  }, [runtime]);

  return <PhoneOSApp runtime={runtime} />;
}

const root = typeof document === 'undefined' ? null : document.getElementById('root');
if (root) {
  const layoutRegistry = createLayoutRegistry();
  const { kernel, director } = createGameRuntime({
    layout: layoutRegistry.getLayoutMetrics(),
    onVibrate: (pattern) => {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate([...pattern]);
    },
    autoStartIntro: false,
  });

  createRoot(root).render(
    <StrictMode><BrowserPhone runtime={{ kernel, director, layoutRegistry }} /></StrictMode>,
  );
}
