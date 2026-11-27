import { LOCKSCREEN_APP_ID, PET_APP_ID, registerBuiltInApps } from '../apps/registry.ts';
import type { LayoutMetrics } from '../apps/pet/brain.ts';
import { Kernel } from '../kernel/Kernel.ts';
import type { ActionRouteHandler } from '../kernel/Kernel.ts';
import { initialKernelState, IntroDirector } from './introSequence.ts';
import type { IntroReason } from './introSequence.ts';

type ScreenPoint = { readonly x: number; readonly y: number };

export type SystemAction =
  | { readonly type: 'TRIGGER_INTRO_RIFT'; readonly payload?: { readonly reason?: IntroReason } }
  | { readonly type: 'POKE_PET' }
  | { readonly type: 'START_DRAG_PET'; readonly payload: ScreenPoint }
  | { readonly type: 'MOVE_DRAG_PET'; readonly payload: ScreenPoint }
  | { readonly type: 'END_DRAG_PET'; readonly payload: ScreenPoint }
  | { readonly type: 'HOLD_PET' }
  | { readonly type: 'SUMMON_PET_TO'; readonly payload: ScreenPoint }
  | { readonly type: 'TAP_STUCK_SLIDER' };

const petActions = [
  'POKE_PET', 'START_DRAG_PET', 'MOVE_DRAG_PET', 'END_DRAG_PET', 'HOLD_PET', 'SUMMON_PET_TO',
] as const satisfies readonly SystemAction['type'][];

const forward: ActionRouteHandler = (action, instance) => {
  if (!instance?.onAction) return false;
  return instance.onAction(action);
};

export function bindGameActions(kernel: Kernel, director: IntroDirector): () => void {
  const removeIntro = kernel.registerActionRoute('TRIGGER_INTRO_RIFT', { bypassInputLock: true }, ({ payload }) => {
    if (payload === undefined) return director.triggerIntroRift();
    if (payload === null || typeof payload !== 'object') return false;
    const reason = 'reason' in payload ? payload.reason : undefined;
    if (reason !== undefined && reason !== 'boot' && reason !== 'debug_replay') return false;
    return director.triggerIntroRift(reason);
  });
  const removeSlider = kernel.registerActionRoute('TAP_STUCK_SLIDER', { targetAppId: LOCKSCREEN_APP_ID }, forward);
  const removePet = petActions.map((type) => kernel.registerActionRoute(type, { targetAppId: PET_APP_ID }, forward));
  return () => {
    removeIntro();
    removeSlider();
    for (const remove of removePet) remove();
  };
}

interface GameRuntimeOptions {
  readonly rng?: () => number;
  readonly layout?: Partial<LayoutMetrics>;
  readonly onVibrate?: (patternMs: readonly number[]) => void;
  readonly autoStartIntro?: boolean;
}

export function createGameRuntime(options: GameRuntimeOptions = {}) {
  const kernel = new Kernel(initialKernelState, { onVibrate: options.onVibrate });
  registerBuiltInApps(kernel, options);
  const director = new IntroDirector(kernel);
  bindGameActions(kernel, director);
  if (options.autoStartIntro !== false) {
    kernel.dispatch({ type: 'TRIGGER_INTRO_RIFT', payload: { reason: 'boot' } } satisfies SystemAction);
  }
  return { kernel, director };
}
