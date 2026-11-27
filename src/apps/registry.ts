import type { Kernel } from '../kernel/Kernel.ts';
import { lockscreenDefinition } from './lockscreen/logic.ts';
import { lockscreenManifest } from './lockscreen/manifest.ts';
import { createPetDefinition } from './pet/brain.ts';
import type { LayoutMetrics } from './pet/brain.ts';
import { petManifest } from './pet/manifest.ts';

export { LOCKSCREEN_APP_ID } from './lockscreen/manifest.ts';
export { PET_APP_ID } from './pet/manifest.ts';

export const APP_MANIFESTS = Object.freeze([lockscreenManifest, petManifest] as const);

interface BuiltInAppOptions {
  readonly rng?: () => number;
  readonly layout?: Partial<LayoutMetrics>;
}

export function createBuiltInAppDefinitions(options?: BuiltInAppOptions) {
  return [lockscreenDefinition, createPetDefinition(options)] as const;
}

export function registerBuiltInApps(kernel: Kernel, options?: BuiltInAppOptions): void {
  const [lockscreen, pet] = createBuiltInAppDefinitions(options);
  const lockscreenResult = kernel.registerApp(lockscreen);
  if (!lockscreenResult.ok) throw new Error(lockscreenResult.message);
  const petResult = kernel.registerApp(pet);
  if (!petResult.ok) throw new Error(petResult.message);
}
