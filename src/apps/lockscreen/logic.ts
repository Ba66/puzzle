import type { AppDefinition } from '../../kernel/types.ts';
import { lockscreenManifest } from './manifest.ts';

export interface TapRipple {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly createdAtMs: number;
  readonly durationMs: number;
}

export interface LockScreenState {
  readonly locked: true;
  readonly stuckShakeSeq: number;
  readonly lastShakeAtMs: number | null;
  readonly tapCount: number;
  readonly ripples: readonly TapRipple[];
}

const initialState: LockScreenState = Object.freeze({
  locked: true,
  stuckShakeSeq: 0,
  lastShakeAtMs: null,
  tapCount: 0,
  ripples: Object.freeze([]),
});
const stuckVibration = Object.freeze([25, 35, 25]);

export const lockscreenDefinition: AppDefinition<LockScreenState> = {
  manifest: lockscreenManifest,
  createProcess: ({ handle, getNowMs }) => {
    let state = initialState;
    let nextRippleId = 1;
    let replayEpoch = 0;

    handle.ipcSubscribe('pet.summon_ripple', ({ payload }) => {
      if (!payload || typeof payload !== 'object' || !('x' in payload) || !('y' in payload)) return;
      const { x, y } = payload;
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return;
      const ripple = Object.freeze({
        id: nextRippleId++,
        x: Math.max(0, Math.min(1, x)),
        y: Math.max(0, Math.min(1, y)),
        createdAtMs: getNowMs(),
        durationMs: 650,
      });
      state = Object.freeze({ ...state, ripples: Object.freeze([...state.ripples, ripple]) });
    });
    handle.ipcSubscribe('director.replay_reset', ({ senderId, senderPid, payload }) => {
      if (senderId !== 'director' || senderPid !== null) return;
      if (!payload || typeof payload !== 'object' || !('epoch' in payload)) return;
      const { epoch } = payload;
      if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch <= replayEpoch) return;
      replayEpoch = epoch;
      state = initialState;
    });

    return {
      getState: () => state,
      onAction: ({ type }) => {
        if (type !== 'TAP_STUCK_SLIDER') return false;
        const epoch = replayEpoch;
        handle.halVibrate(stuckVibration);
        if (epoch !== replayEpoch) return true;
        const timestampMs = getNowMs();
        const shakeSeq = state.stuckShakeSeq + 1;
        const tapCount = state.tapCount + 1;
        state = Object.freeze({ ...state, stuckShakeSeq: shakeSeq, tapCount, lastShakeAtMs: timestampMs });
        handle.ipcPublish('lockscreen.slider_stuck', { tapCount, shakeSeq, timestampMs });
        if (epoch === replayEpoch) handle.dmesgWrite('info', 'lockscreen.slider_stuck', `Tap ${tapCount}`);
        return true;
      },
      onTick: (_dtMs, nowMs) => {
        const ripples = state.ripples.filter(({ createdAtMs, durationMs }) => nowMs - createdAtMs < durationMs);
        if (ripples.length !== state.ripples.length) {
          state = Object.freeze({ ...state, ripples: Object.freeze(ripples) });
        }
      },
    };
  },
};
