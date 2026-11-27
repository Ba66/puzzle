import type { AppManifest } from '../../kernel/types.ts';

export const PET_APP_ID = 'unknown.pet';

export const petManifest = Object.freeze({
  appId: PET_APP_ID,
  name: 'Unknown Pet',
  version: '0.1.0-anomaly',
  defaultLayer: 'overlay',
  singleton: true,
  requestedPermissions: Object.freeze(['ipc:send', 'ipc:subscribe', 'vfs:read', 'dmesg:write'] as const),
  hiddenPermissions: Object.freeze(['kernel:reality-breach', 'overlay:unbounded', 'sensor:fourth-wall']),
} satisfies AppManifest);
