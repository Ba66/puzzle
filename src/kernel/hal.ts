import { failure, success } from './types.ts';
import type {
  DeviceType,
  HalStateSnapshot,
  HalVibrationEvent,
  HardwareState,
  InitialKernelState,
  SyscallResult,
} from './types.ts';

const VIBRATION_HISTORY_LIMIT = 32;

export class Hal {
  readonly device: DeviceType;
  readonly hardware: HardwareState;
  readonly #onVibrate: ((patternMs: readonly number[]) => void) | undefined;
  #state: HalStateSnapshot = Object.freeze({
    lastVibration: null,
    vibrationCount: 0,
    history: Object.freeze([]),
  });

  constructor(initialState: InitialKernelState, onVibrate?: (patternMs: readonly number[]) => void) {
    this.device = initialState.device;
    this.hardware = Object.freeze({ ...initialState.hardware });
    this.#onVibrate = onVibrate;
  }

  getSnapshot(): HalStateSnapshot {
    return this.#state;
  }

  vibrate(patternMs: readonly number[], nowMs: number): SyscallResult<HalVibrationEvent> {
    if (!Array.isArray(patternMs)) {
      return failure('INVALID_STATE', 'A vibration pattern must be an array of durations.');
    }

    const durations = [...patternMs];
    if (durations.some((duration) => !Number.isFinite(duration) || duration < 0)) {
      return failure('INVALID_STATE', 'Vibration durations must be finite and non-negative.');
    }

    const event = Object.freeze({
      seq: this.#state.vibrationCount + 1,
      timestampMs: nowMs,
      patternMs: Object.freeze(durations),
    });
    const history = [...this.#state.history.slice(1 - VIBRATION_HISTORY_LIMIT), event];
    this.#state = Object.freeze({
      lastVibration: event,
      vibrationCount: event.seq,
      history: Object.freeze(history),
    });
    this.#onVibrate?.(event.patternMs);

    return success(event);
  }
}
