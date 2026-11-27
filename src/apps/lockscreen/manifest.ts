import type { AppManifest } from '../../kernel/types.ts';

export const LOCKSCREEN_APP_ID = 'system.lockscreen';

export const lockscreenManifest = Object.freeze({
  appId: LOCKSCREEN_APP_ID,
  name: 'Lock Screen',
  version: '1.0.0',
  defaultLayer: 'system',
  singleton: true,
  requestedPermissions: Object.freeze(['hal:vibrate', 'ipc:send', 'ipc:subscribe', 'dmesg:write'] as const),
} satisfies AppManifest);
