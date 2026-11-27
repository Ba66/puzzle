import { createContext, createElement, useContext, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { useStore } from 'zustand';
import type { LockScreenState } from '../apps/lockscreen/logic.ts';
import { LOCKSCREEN_APP_ID } from '../apps/lockscreen/manifest.ts';
import type { PetState } from '../apps/pet/brain.ts';
import { PET_APP_ID } from '../apps/pet/manifest.ts';
import type { DirectorSnapshot, IntroDirector } from '../director/introSequence.ts';
import type { Kernel } from '../kernel/Kernel.ts';
import type { KernelSnapshot } from '../kernel/types.ts';
import type { LayoutRegistry } from './layoutRegistry.ts';

export interface PhoneRuntime {
  readonly kernel: Kernel;
  readonly director: IntroDirector;
  readonly layoutRegistry: LayoutRegistry;
}

const RuntimeContext = createContext<PhoneRuntime | null>(null);

export function RuntimeProvider({ runtime, children }: { runtime: PhoneRuntime; children: ReactNode }) {
  return createElement(RuntimeContext.Provider, { value: runtime }, children);
}

export function useRuntime(): PhoneRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error('PhoneOS requires a RuntimeProvider.');
  return runtime;
}

export function useKernelSelector<T>(selector: (snapshot: KernelSnapshot) => T): T {
  return useStore(useRuntime().kernel.getStore(), selector);
}

export function useKernelSnapshot(): KernelSnapshot {
  return useKernelSelector((snapshot) => snapshot);
}

export function useDirectorSelector<T>(selector: (snapshot: DirectorSnapshot) => T): T {
  return useStore(useRuntime().director.getStore(), selector);
}

export function useDirectorSnapshot(): DirectorSnapshot {
  return useDirectorSelector((snapshot) => snapshot);
}

function useProcessState<T>(appId: string): T | undefined {
  const { kernel } = useRuntime();
  // The kernel publishes a new revision after process actions, IPC and ticks.
  return useKernelSelector(({ processes }) => {
    const process = processes.find((entry) => entry.appId === appId && entry.status !== 'terminated');
    return process ? kernel.getProcessState<T>(process.pid) : undefined;
  });
}

export function usePetState(): PetState | undefined {
  return useProcessState<PetState>(PET_APP_ID);
}

export function useLockScreenState(): LockScreenState | undefined {
  return useProcessState<LockScreenState>(LOCKSCREEN_APP_ID);
}

export function useLayoutMetrics() {
  const { layoutRegistry } = useRuntime();
  return useSyncExternalStore(layoutRegistry.subscribe, layoutRegistry.getLayoutMetrics, layoutRegistry.getLayoutMetrics);
}

export function useScreenRect() {
  const { layoutRegistry } = useRuntime();
  return useSyncExternalStore(layoutRegistry.subscribe, layoutRegistry.getRect, layoutRegistry.getRect);
}
