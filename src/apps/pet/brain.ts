import type { AppDefinition, AppProcessContext, AppProcessInstance, IpcMessage, KernelAction } from '../../kernel/types.ts';
import {
  EASTER_EGG_SOOTHE_LINES,
  INTRO_GREETING,
  LAND_COMPLAINT_LINES,
  pickNonRepeating,
  POKE_LINES,
  SLIDER_STUCK_LINES,
  SOOTHE_LINES,
} from './dialogue.ts';
import { petManifest } from './manifest.ts';

export const WIREFRAME_EASTER_EGG_PROBABILITY = 0.15;
export const WIREFRAME_FLASH_DURATION_MS = 80;

export interface LayoutMetrics {
  readonly aspectRatio: number;
  readonly floorYNorm: number;
  readonly topSafeNorm: number;
  readonly petWidthIso: number;
  readonly petHeightIso: number;
}

export const DEFAULT_LAYOUT_METRICS: LayoutMetrics = Object.freeze({
  aspectRatio: 2,
  floorYNorm: 0.83,
  topSafeNorm: 0.08,
  petWidthIso: 0.22,
  petHeightIso: 0.26,
});

export const GRAVITY_ISO = 5.6;
export const BOUNCE_RESTITUTION = 0.36;
export const WALL_RESTITUTION = 0.42;
export const GROUND_FRICTION = 10;
export const MAX_THROW_VX_ISO = 3;
export const MAX_THROW_VY_ISO = 3.4;
export const TILT_FROM_VX_GAIN = 14;
export const TILT_DAMPING = 19;
export const MAX_TILT_DEG = 28;
export const SUMMON_SPEED_ISO = 0.92;
export const SUMMON_HOP_VY_ISO = 0.70;

const PHYSICS_STEP_MS = 5;
const DRAG_WINDOW_MS = 100;
const DRAG_PAUSE_MS = 60;
const DRAG_PAUSE_DAMPING = 55;
const FLOOR_SPEED_EPSILON = 0.08;
const BOUNCE_SPEED_EPSILON = 0.28;
const SUMMON_X_EPSILON = 0.002;
const LANDING_RECOVERY_MS = 220;
const TIME_EPSILON_MS = 1e-7;
const INTRO_SLIDE_NORM_PER_SECOND = 0.12 / 0.45;

type Point = { readonly x: number; readonly y: number };
type Sample = Point & { readonly timeMs: number };
type BubbleTone = 'intro' | 'poke' | 'land' | 'soothe' | 'slider' | 'easter_egg';

export type PetFsmState =
  | 'INTRO_EMERGE' | 'INTRO_SPLAT' | 'INTRO_SLIDE' | 'INTRO_FALL' | 'INTRO_RECOVER'
  | 'IDLE_ROAM' | 'POKED' | 'SOOTHED' | 'DRAGGED' | 'FALLING' | 'LANDING' | 'SUMMON_MOVE';

export type PetExpression =
  | 'neutral' | 'curious' | 'squint' | 'glare' | 'pout' | 'panic' | 'dizzy' | 'shy' | 'splat' | 'annoyed';

export interface PetState {
  readonly fsm: PetFsmState;
  readonly expression: PetExpression;
  readonly x: number;
  readonly y: number;
  readonly ix: number;
  readonly iy: number;
  readonly vxIso: number;
  readonly vyIso: number;
  readonly squashX: number;
  readonly squashY: number;
  readonly tiltDeg: number;
  readonly flailing: boolean;
  readonly headShakeActive: boolean;
  readonly shyWobbleActive: boolean;
  readonly wireframeFlashActive: boolean;
  readonly wireframeFlashRemainingMs: number;
  readonly facing: -1 | 0 | 1;
  readonly lookTarget: Point | null;
  readonly bubble: {
    readonly id: number;
    readonly text: string;
    readonly remainingMs: number;
    readonly totalMs: number;
    readonly tone: BubbleTone;
  } | null;
  readonly landComplaintCount: number;
  readonly introLanded: boolean;
  readonly summonTarget: Point | null;
  readonly queuedSummonTarget: Point | null;
  readonly layout: LayoutMetrics;
}

export type IntroBeat = 'SPLAT' | 'SLIDE' | 'FALL' | 'RECOVER' | 'GREET';
type IntroCue = IntroBeat | 'HANDOFF';

export interface PetInitOptions {
  readonly layout?: Partial<LayoutMetrics>;
  readonly intro?: {
    readonly epoch: number;
    readonly spawnAtMs: number;
    readonly cues: readonly { readonly beat: IntroCue; readonly atMs: number }[];
  };
}

interface Bounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

interface Reaction {
  readonly token: number;
  readonly expression: PetExpression;
  readonly look: Point | null;
  readonly pose?: 'POKED' | 'SOOTHED';
  readonly shyWobble: boolean;
  remainingMs: number;
}

const pokeExpressions = ['squint', 'glare', 'pout'] as const;
const centerLook = Object.freeze({ x: 0.5, y: 0.5 });
const sliderLook = Object.freeze({ x: 0.5, y: 0.92 });

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function damp(value: number, target: number, rate: number, dtMs: number): number {
  return target + (value - target) * Math.exp(-rate * (dtMs / 1000));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function readPoint(value: unknown): Point | undefined {
  const point = asRecord(value);
  if (!point) return;
  const { x, y } = point;
  if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
    return { x, y };
  }
}

function normalizedPoint({ x, y }: Point): Point {
  return Object.freeze({ x: clamp(x, 0, 1), y: clamp(y, 0, 1) });
}

export function readLayoutMetrics(value: unknown, defaults?: LayoutMetrics): LayoutMetrics | undefined {
  const layout = { ...defaults, ...asRecord(value) };
  const { aspectRatio, floorYNorm, topSafeNorm, petWidthIso, petHeightIso } = layout;
  if (typeof aspectRatio !== 'number' || !Number.isFinite(aspectRatio) || aspectRatio <= 0
    || typeof floorYNorm !== 'number' || !(floorYNorm > 0 && floorYNorm <= 1)
    || typeof topSafeNorm !== 'number' || !(topSafeNorm >= 0 && topSafeNorm < floorYNorm)
    || typeof petWidthIso !== 'number' || !(petWidthIso > 0 && petWidthIso <= 0.96)
    || typeof petHeightIso !== 'number' || !(petHeightIso > 0 && Number.isFinite(petHeightIso))
    || topSafeNorm * aspectRatio + petHeightIso > floorYNorm * aspectRatio) return;
  return Object.freeze({ aspectRatio, floorYNorm, topSafeNorm, petWidthIso, petHeightIso });
}

function boundsFor(layout: LayoutMetrics): Bounds {
  const minX = layout.petWidthIso / 2 + 0.02;
  return {
    minX,
    maxX: 1 - minX,
    minY: layout.topSafeNorm * layout.aspectRatio + layout.petHeightIso,
    maxY: layout.floorYNorm * layout.aspectRatio,
  };
}

export function createPetDefinition(
  options: { readonly rng?: () => number; readonly layout?: Partial<LayoutMetrics> } = {},
): AppDefinition<PetState, PetInitOptions> {
  const rng = options.rng ?? Math.random;
  const layout = readLayoutMetrics(options.layout, DEFAULT_LAYOUT_METRICS) ?? DEFAULT_LAYOUT_METRICS;
  return {
    manifest: petManifest,
    createProcess: (context) => new PetBrain(context, rng, layout),
  };
}

class PetBrain implements AppProcessInstance<PetState> {
  readonly #context: AppProcessContext<PetInitOptions>;
  readonly #rng: () => number;
  readonly #intro: PetInitOptions['intro'];
  readonly #lastLine: Partial<Record<BubbleTone, number>> = {};
  #nextIntroCue = 0;
  #resumeIntro = false;
  #advancedAtMs: number;
  #layout: LayoutMetrics;
  #bounds: Bounds;
  #snapshot: PetState | undefined;

  #fsm: PetFsmState;
  #expression: PetExpression;
  #ix = 0.5;
  #iy: number;
  #vx = 0;
  #vy = 0;
  #squashX = 1;
  #squashY = 1;
  #tiltDeg = 0;
  #flailing = false;
  #facing: -1 | 0 | 1 = 0;
  #motionMs = 0;
  #headShakeMs = 0;
  #wireframeMs = 0;
  #look: Point | null = null;
  #lookMs = 0;
  #bubble: PetState['bubble'] = null;
  #nextBubbleId = 1;
  #lastPokeExpression = -1;
  #reactionToken = 0;
  #reaction: Reaction | null = null;

  #introLanded = false;
  #hasComplainedThisFall = false;
  #landComplaintCount = 0;
  #landing: { remainingMs: number; token: number } | null = null;
  #summon: Point | null = null;
  #queuedSummon: Point | null = null;
  #idleMs = 0;
  #idleOriginX = 0.5;

  #grabOffset: Point = { x: 0, y: 0 };
  #pointer: Point | null = null;
  #samples: Sample[] = [];

  constructor(context: AppProcessContext<PetInitOptions>, rng: () => number, layout: LayoutMetrics) {
    this.#context = context;
    this.#rng = rng;
    this.#intro = context.initOptions?.intro;
    this.#advancedAtMs = this.#intro?.spawnAtMs ?? context.getNowMs();
    this.#layout = readLayoutMetrics(context.initOptions?.layout, layout) ?? layout;
    this.#bounds = boundsFor(this.#layout);
    this.#fsm = this.#intro ? 'INTRO_EMERGE' : 'IDLE_ROAM';
    this.#expression = this.#intro ? 'panic' : 'neutral';
    this.#iy = this.#intro ? this.#introY(0.14) : this.#bounds.maxY;
    if (this.#intro) this.#squash(0.48, 0.55);

    const { handle } = context;
    handle.ipcSubscribe('director.intro_beat', (message) => this.#onIntroMessage(message, false));
    handle.ipcSubscribe('director.intro_handoff', (message) => this.#onIntroMessage(message, true));
    handle.ipcSubscribe('system.layout_changed', ({ payload }) => {
      const next = readLayoutMetrics(asRecord(payload)?.layout);
      if (next) this.#resize(next);
    });
    handle.ipcSubscribe('lockscreen.slider_stuck', () => this.#onSliderStuck());
  }

  getState(): PetState {
    return this.#snapshot ??= Object.freeze({
      fsm: this.#fsm,
      expression: this.#reaction?.expression ?? this.#expression,
      x: this.#ix,
      y: this.#iy / this.#layout.aspectRatio,
      ix: this.#ix,
      iy: this.#iy,
      vxIso: this.#vx,
      vyIso: this.#vy,
      squashX: this.#squashX,
      squashY: this.#squashY,
      tiltDeg: this.#tiltDeg,
      flailing: this.#flailing,
      headShakeActive: this.#headShakeMs > 0,
      shyWobbleActive: this.#reaction?.shyWobble ?? false,
      wireframeFlashActive: this.#wireframeMs > 0,
      wireframeFlashRemainingMs: this.#wireframeMs,
      facing: this.#facing,
      lookTarget: this.#reaction?.look ?? this.#look,
      bubble: this.#bubble,
      landComplaintCount: this.#landComplaintCount,
      introLanded: this.#introLanded,
      summonTarget: this.#summon,
      queuedSummonTarget: this.#queuedSummon,
      layout: this.#layout,
    });
  }

  onTick(_dtMs: number, nowMs: number): void {
    if (this.#resumeIntro) {
      this.#resumeIntro = false;
      for (const cue of this.#intro?.cues.slice(this.#nextIntroCue) ?? []) {
        if (cue.atMs > nowMs) break;
        this.#applyCue(cue.beat, cue.atMs);
      }
    }
    this.#advanceTo(nowMs);
  }

  onResume(): void {
    this.#advancedAtMs = this.#context.getNowMs();
    this.#resumeIntro = this.#inIntro();
    if (this.#fsm === 'DRAGGED') this.#samples = [];
  }

  onAction({ type, payload }: KernelAction): boolean {
    if (this.#inIntro()) return false;
    switch (type) {
      case 'POKE_PET':
        this.#poke();
        break;
      case 'HOLD_PET':
        this.#soothe();
        break;
      case 'START_DRAG_PET':
      case 'MOVE_DRAG_PET':
      case 'END_DRAG_PET':
      case 'SUMMON_PET_TO': {
        const point = readPoint(payload);
        if (!point) return false;
        if (type === 'START_DRAG_PET') {
          if (this.#fsm === 'DRAGGED') return false;
          this.#startDrag(point);
        } else if (type === 'SUMMON_PET_TO') {
          this.#requestSummon(normalizedPoint(point));
        } else {
          if (this.#fsm !== 'DRAGGED') return false;
          const nowMs = this.#context.getNowMs();
          this.#moveDrag(point, nowMs, type === 'END_DRAG_PET');
          if (type === 'END_DRAG_PET') this.#endDrag();
        }
        break;
      }
      default:
        return false;
    }
    this.#snapshot = undefined;
    return true;
  }

  #inIntro(): boolean {
    return this.#fsm.startsWith('INTRO_');
  }

  #introY(ny: number): number {
    return clamp(ny * this.#layout.aspectRatio, this.#bounds.minY, this.#bounds.maxY);
  }

  #onIntroMessage({ senderId, senderPid, payload, timestampMs }: IpcMessage, handoff: boolean): void {
    if (!this.#inIntro() || senderId !== 'director' || senderPid !== null || !this.#intro) return;
    const data = asRecord(payload);
    if (data?.epoch !== this.#intro.epoch) return;
    const beat = handoff ? 'HANDOFF' : data.beat;
    const pending = this.#intro.cues.slice(this.#nextIntroCue);
    const index = pending.findIndex((cue) => cue.beat === beat);
    if (index < 0 || pending[index].atMs > timestampMs) return;
    if (index > 0 && !this.#resumeIntro) return;
    for (const cue of pending.slice(0, index + 1)) this.#applyCue(cue.beat, cue.atMs);
  }

  #applyCue(beat: IntroCue, atMs: number): void {
    this.#advanceTo(atMs);
    this.#nextIntroCue++;
    this.#motionMs = 0;
    switch (beat) {
      case 'SPLAT':
        this.#fsm = 'INTRO_SPLAT';
        this.#expression = 'splat';
        this.#iy = this.#introY(0.34);
        this.#squash(1.44, 0.56);
        break;
      case 'SLIDE':
        this.#fsm = 'INTRO_SLIDE';
        this.#expression = 'dizzy';
        this.#vy = this.#iy < this.#bounds.maxY ? INTRO_SLIDE_NORM_PER_SECOND * this.#layout.aspectRatio : 0;
        this.#squash(0.92, 1.12);
        break;
      case 'FALL':
        this.#fsm = 'INTRO_FALL';
        this.#expression = 'panic';
        this.#vy = 1.75;
        break;
      case 'RECOVER':
        if (!this.#introLanded) this.#introImpact();
        this.#fsm = 'INTRO_RECOVER';
        this.#iy = this.#bounds.maxY;
        this.#vx = this.#vy = 0;
        this.#expression = 'dizzy';
        this.#headShakeMs = 380;
        break;
      case 'GREET':
        this.#showBubble(INTRO_GREETING, 'intro', 6500);
        break;
      case 'HANDOFF':
        this.#headShakeMs = 0;
        this.#setLook(centerLook, 1000);
        this.#enterIdle();
        break;
    }
    this.#snapshot = undefined;
  }

  #advanceTo(nowMs: number): void {
    let remaining = nowMs - this.#advancedAtMs;
    if (remaining <= 0) return;

    // A single kernel tick can cross several cues. Each cue consumes only the time before it.
    let atMs = this.#advancedAtMs;
    this.#advancedAtMs = nowMs;
    this.#snapshot = undefined;
    while (remaining > TIME_EPSILON_MS) {
      const moving = this.#needsPhysics();
      const step = Math.min(
        remaining,
        moving ? PHYSICS_STEP_MS - this.#motionMs : Infinity,
        this.#reaction?.remainingMs ?? Infinity,
        this.#headShakeMs || Infinity,
        this.#lookMs || Infinity,
      );

      if (this.#fsm === 'IDLE_ROAM' && !this.#look && !this.#reaction) this.#advanceIdle(step);
      if (this.#fsm === 'INTRO_SLIDE') {
        this.#iy = Math.min(this.#bounds.maxY, this.#iy + this.#vy * step / 1000);
        if (this.#iy === this.#bounds.maxY) this.#vy = 0;
      }
      if (this.#fsm !== 'INTRO_SPLAT' && this.#fsm !== 'INTRO_SLIDE') {
        this.#squashX = damp(this.#squashX, 1, 9, step);
        this.#squashY = damp(this.#squashY, 1, 9, step);
      }
      if (this.#fsm === 'DRAGGED') this.#dampDrag(atMs, step);
      else this.#tiltDeg = damp(this.#tiltDeg, 0, TILT_DAMPING, step);
      this.#advanceTimers(step);

      if (moving) {
        this.#motionMs += step;
        if (this.#motionMs >= PHYSICS_STEP_MS - TIME_EPSILON_MS) {
          this.#motionMs = 0;
          this.#stepPhysics();
        }
      }
      atMs += step;
      remaining -= step;
    }
  }

  #advanceTimers(dtMs: number): void {
    if (this.#bubble) {
      const remainingMs = this.#bubble.remainingMs - dtMs;
      this.#bubble = remainingMs > TIME_EPSILON_MS ? Object.freeze({ ...this.#bubble, remainingMs }) : null;
    }
    this.#wireframeMs = Math.max(0, this.#wireframeMs - dtMs);
    if (this.#headShakeMs > 0) {
      this.#headShakeMs = Math.max(0, this.#headShakeMs - dtMs);
      if (this.#headShakeMs === 0) {
        this.#expression = 'curious';
        this.#setLook(centerLook);
      }
    }
    if (this.#lookMs > 0) {
      this.#lookMs = Math.max(0, this.#lookMs - dtMs);
      if (this.#lookMs === 0) {
        this.#look = null;
        if (this.#fsm === 'IDLE_ROAM') this.#expression = 'neutral';
      }
    }
    const reaction = this.#reaction;
    if (reaction) {
      reaction.remainingMs -= dtMs;
      if (reaction.remainingMs <= TIME_EPSILON_MS && reaction.token === this.#reactionToken) {
        this.#reaction = null;
        if (reaction.pose === this.#fsm) this.#enterIdle();
      }
    }
  }

  #needsPhysics(): boolean {
    return this.#fsm === 'FALLING' || this.#fsm === 'LANDING' || this.#fsm === 'SUMMON_MOVE'
      || (this.#fsm === 'INTRO_FALL' && (!this.#introLanded || this.#vy !== 0));
  }

  #stepPhysics(): void {
    const dtSec = PHYSICS_STEP_MS / 1000;
    if (this.#fsm === 'INTRO_FALL' || this.#fsm === 'FALLING') this.#fall(dtSec);
    else if (this.#fsm === 'LANDING') this.#recoverOnFloor(dtSec);
    else if (this.#fsm === 'SUMMON_MOVE') this.#hopTowardSummon(dtSec);
  }

  #fall(dtSec: number): void {
    const { minX, maxX, minY, maxY } = this.#bounds;
    const intro = this.#fsm === 'INTRO_FALL';
    if (!intro && this.#hasComplainedThisFall && this.#iy === maxY && this.#vy === 0) {
      this.#slideOnFloor(dtSec);
      if (this.#vx === 0) this.#enterLanding();
      return;
    }

    this.#ix += this.#vx * dtSec;
    if (this.#ix < minX || this.#ix > maxX) {
      this.#ix = clamp(this.#ix, minX, maxX);
      this.#vx *= -WALL_RESTITUTION;
    }

    this.#iy += this.#vy * dtSec + GRAVITY_ISO * dtSec * dtSec / 2;
    this.#vy += GRAVITY_ISO * dtSec;
    if (this.#iy < minY) {
      this.#iy = minY;
      this.#vy = Math.abs(this.#vy) * WALL_RESTITUTION;
    }
    this.#flailing = !intro && Math.hypot(this.#vx, this.#vy) > 1.35;
    if (this.#iy < maxY) return;

    this.#iy = maxY;
    this.#squash(1.34, 0.66);
    const rebound = Math.abs(this.#vy) * BOUNCE_RESTITUTION;
    if (intro) {
      this.#vy = this.#introLanded ? 0 : -Math.min(0.58, rebound);
      if (!this.#introLanded) this.#introImpact();
      return;
    }

    if (!this.#hasComplainedThisFall) {
      this.#hasComplainedThisFall = true;
      this.#landComplaintCount++;
      this.#context.handle.dmesgWrite('info', 'pet.land', 'Released');
      this.#speak(LAND_COMPLAINT_LINES, 'land', 2200);
    }
    this.#vx *= 0.68;
    this.#vy = rebound < BOUNCE_SPEED_EPSILON ? 0 : -rebound;
    this.#flailing = Math.hypot(this.#vx, this.#vy) > 1.35;
    if (this.#vy === 0 && Math.abs(this.#vx) < FLOOR_SPEED_EPSILON) this.#enterLanding();
  }

  #introImpact(): void {
    this.#introLanded = true;
    this.#context.handle.dmesgWrite('info', 'pet.land', 'Intro');
  }

  #slideOnFloor(dtSec: number): void {
    this.#vx *= Math.exp(-GROUND_FRICTION * dtSec);
    const nextX = this.#ix + this.#vx * dtSec;
    this.#ix = clamp(nextX, this.#bounds.minX, this.#bounds.maxX);
    if (this.#ix !== nextX || Math.abs(this.#vx) < FLOOR_SPEED_EPSILON) this.#vx = 0;
    this.#flailing = false;
  }

  #enterLanding(): void {
    this.#fsm = 'LANDING';
    this.#expression = 'dizzy';
    this.#iy = this.#bounds.maxY;
    this.#vy = 0;
    this.#flailing = false;
    if (Math.abs(this.#vx) < FLOOR_SPEED_EPSILON) this.#vx = 0;
    this.#landing = { remainingMs: LANDING_RECOVERY_MS, token: this.#reactionToken };
  }

  #recoverOnFloor(dtSec: number): void {
    const landing = this.#landing;
    if (!landing || landing.token !== this.#reactionToken) return;
    this.#slideOnFloor(dtSec);
    landing.remainingMs -= PHYSICS_STEP_MS;
    if (this.#vx !== 0 || landing.remainingMs > 0) return;
    this.#landing = null;
    if (this.#queuedSummon) this.#beginSummon(this.#queuedSummon);
    else this.#enterIdle();
  }

  #startDrag(pointer: Point): void {
    this.#clearReaction();
    this.#setLook(null);
    this.#summon = null;
    this.#landing = null;
    this.#fsm = 'DRAGGED';
    this.#expression = 'panic';
    this.#flailing = true;
    this.#motionMs = this.#vx = this.#vy = this.#tiltDeg = 0;
    this.#pointer = pointer;
    this.#grabOffset = { x: this.#ix - pointer.x, y: this.#iy - this.#pointerY(pointer) };
    this.#samples = [{ x: this.#ix, y: this.#iy, timeMs: this.#context.getNowMs() }];
  }

  #pointerY(point: Point): number {
    // Keep finite, off-screen pointer coordinates usable even when scaling would overflow.
    return clamp(point.y * this.#layout.aspectRatio, -Number.MAX_VALUE, Number.MAX_VALUE);
  }

  #moveDrag(pointer: Point, nowMs: number, releasing: boolean): void {
    const last = this.#samples.at(-1);
    if (pointer.x !== this.#pointer?.x) {
      this.#ix = clamp(pointer.x + this.#grabOffset.x, this.#bounds.minX, this.#bounds.maxX);
    }
    if (pointer.y !== this.#pointer?.y) {
      this.#iy = clamp(this.#pointerY(pointer) + this.#grabOffset.y, this.#bounds.minY, this.#bounds.maxY);
    }
    this.#pointer = pointer;
    // An unchanged release uses the velocity already decayed by ticks during a pause.
    if (releasing && (!last || (this.#ix === last.x && this.#iy === last.y))) return;
    const sample = { x: this.#ix, y: this.#iy, timeMs: nowMs };
    this.#samples = this.#samples.filter(({ timeMs }) => nowMs - timeMs <= DRAG_WINDOW_MS && timeMs < nowMs);
    const first = this.#samples[0];
    this.#samples.push(sample);
    const sampleMs = first ? nowMs - first.timeMs : 0;
    if (first && sampleMs > TIME_EPSILON_MS) {
      this.#vx = clamp((sample.x - first.x) * 1000 / sampleMs, -MAX_THROW_VX_ISO, MAX_THROW_VX_ISO);
      this.#vy = clamp((sample.y - first.y) * 1000 / sampleMs, -MAX_THROW_VY_ISO, MAX_THROW_VY_ISO);
      this.#tiltDeg = damp(this.#tiltDeg, this.#dragTilt(), TILT_DAMPING, nowMs - (last?.timeMs ?? first.timeMs));
    } else if (last?.timeMs !== nowMs) {
      this.#vx = this.#vy = 0;
    }
  }

  #dragTilt(): number {
    return clamp(-this.#vx * TILT_FROM_VX_GAIN, -MAX_TILT_DEG, MAX_TILT_DEG);
  }

  #dampDrag(atMs: number, dtMs: number): void {
    const last = this.#samples.at(-1);
    const freshMs = last ? clamp(last.timeMs + DRAG_PAUSE_MS - atMs, 0, dtMs) : 0;
    this.#tiltDeg = damp(this.#tiltDeg, this.#dragTilt(), TILT_DAMPING, freshMs);
    const pausedMs = dtMs - freshMs;
    this.#vx = damp(this.#vx, 0, DRAG_PAUSE_DAMPING, pausedMs);
    this.#vy = damp(this.#vy, 0, DRAG_PAUSE_DAMPING, pausedMs);
    this.#tiltDeg = damp(this.#tiltDeg, 0, TILT_DAMPING, pausedMs);
  }

  #endDrag(): void {
    const noSamples = this.#samples.length === 0;
    this.#samples = [];
    this.#pointer = null;
    this.#clearReaction();
    this.#hasComplainedThisFall = false;
    this.#flailing = false;
    this.#motionMs = 0;
    if (noSamples) this.#vx = this.#vy = 0;
    if (this.#iy < this.#bounds.maxY - 0.004 || this.#vy < -0.05 || this.#vy > BOUNCE_SPEED_EPSILON) {
      this.#fsm = 'FALLING';
      this.#expression = 'panic';
    } else {
      this.#enterLanding();
    }
  }

  #requestSummon(target: Point): void {
    if (this.#fsm === 'DRAGGED' || this.#fsm === 'FALLING') this.#queuedSummon = target;
    else this.#beginSummon(target);
    this.#snapshot = undefined;
    this.#context.handle.ipcPublish('pet.summon_ripple', target);
  }

  #beginSummon(target: Point): void {
    if (this.#fsm !== 'SUMMON_MOVE') {
      this.#motionMs = 0;
      this.#vx = this.#vy = 0;
      this.#iy = this.#bounds.maxY;
    }
    this.#clearReaction();
    this.#setLook(null);
    this.#landing = null;
    this.#summon = target;
    this.#queuedSummon = null;
    this.#fsm = 'SUMMON_MOVE';
    this.#expression = 'curious';
  }

  #hopTowardSummon(dtSec: number): void {
    if (!this.#summon) return;
    const { minX, maxX, minY, maxY } = this.#bounds;
    const targetX = clamp(this.#summon.x, minX, maxX);
    const distance = targetX - this.#ix;
    const grounded = this.#iy === maxY && this.#vy === 0;
    if (grounded && Math.abs(distance) <= SUMMON_X_EPSILON) {
      this.#ix = targetX;
      this.#setLook(this.#summon, 1500);
      this.#summon = null;
      this.#vx = 0;
      this.#enterIdle();
      return;
    }

    const dx = Math.sign(distance) * Math.min(Math.abs(distance), SUMMON_SPEED_ISO * dtSec);
    const headroom = maxY - minY;
    if (grounded && headroom > 0) {
      this.#vy = -Math.min(SUMMON_HOP_VY_ISO, Math.sqrt(2 * GRAVITY_ISO * headroom));
      this.#squash(0.94, 1.08);
    }
    if (dx !== 0) this.#facing = dx < 0 ? -1 : 1;
    this.#ix += dx;
    this.#vx = dx / dtSec;
    this.#iy = Math.max(minY, this.#iy + this.#vy * dtSec + GRAVITY_ISO * dtSec * dtSec / 2);
    this.#vy += GRAVITY_ISO * dtSec;
    if (this.#iy >= maxY) {
      this.#iy = maxY;
      this.#vy = 0;
      this.#squash(1.12, 0.90);
    }
  }

  #onSliderStuck(): void {
    this.#speak(SLIDER_STUCK_LINES, 'slider', 2600);
    if (!this.#inIntro() && this.#fsm !== 'DRAGGED' && this.#fsm !== 'FALLING') {
      if (this.#fsm === 'POKED' || this.#fsm === 'SOOTHED') this.#enterIdle();
      this.#startReaction('annoyed', 650, sliderLook);
    }
    this.#snapshot = undefined;
  }

  #poke(): void {
    const { index } = pickNonRepeating(pokeExpressions, this.#lastPokeExpression, this.#rng);
    this.#lastPokeExpression = index;
    this.#squash(1.30, 0.72);
    this.#speak(POKE_LINES, 'poke', 2600);
    this.#startReaction(pokeExpressions[index], 480, null, 'POKED');
  }

  #soothe(): void {
    const wireframe = this.#rng() < WIREFRAME_EASTER_EGG_PROBABILITY;
    if (wireframe) {
      this.#wireframeMs = WIREFRAME_FLASH_DURATION_MS;
      this.#speak(EASTER_EGG_SOOTHE_LINES, 'easter_egg', 2300);
    } else {
      this.#speak(SOOTHE_LINES, 'soothe', 2300);
    }
    this.#startReaction('shy', 1200, null, 'SOOTHED');
  }

  #startReaction(expression: PetExpression, remainingMs: number, look: Point | null, pose?: Reaction['pose']): void {
    const token = ++this.#reactionToken;
    const canChangePose = this.#fsm === 'POKED' || this.#fsm === 'SOOTHED' || this.#fsm === 'IDLE_ROAM';
    const nextPose = canChangePose ? pose : undefined;
    this.#reaction = { token, expression, remainingMs, look, pose: nextPose, shyWobble: pose === 'SOOTHED' };
    if (nextPose) {
      this.#fsm = nextPose;
      this.#setLook(null);
    }
    if (this.#landing) this.#landing.token = token;
    this.#resetIdle();
  }

  #clearReaction(): void {
    this.#reactionToken++;
    this.#reaction = null;
  }

  #speak(lines: readonly string[], tone: BubbleTone, durationMs: number): void {
    const { index, text } = pickNonRepeating(lines, this.#lastLine[tone] ?? -1, this.#rng);
    this.#lastLine[tone] = index;
    this.#showBubble(text, tone, durationMs);
  }

  #showBubble(text: string, tone: BubbleTone, totalMs: number): void {
    this.#bubble = Object.freeze({ id: this.#nextBubbleId++, text, tone, remainingMs: totalMs, totalMs });
  }

  #setLook(target: Point | null, durationMs = 0): void {
    this.#look = target;
    this.#lookMs = durationMs;
  }

  #squash(x: number, y: number): void {
    this.#squashX = x;
    this.#squashY = y;
  }

  #enterIdle(): void {
    this.#fsm = 'IDLE_ROAM';
    this.#expression = this.#look ? 'curious' : 'neutral';
    this.#resetIdle();
  }

  #resetIdle(): void {
    this.#idleOriginX = this.#ix;
    this.#idleMs = 0;
  }

  #advanceIdle(dtMs: number): void {
    // A small weight shift after several quiet seconds, repeating without accumulated drift.
    this.#idleMs = (this.#idleMs + dtMs % 6400) % 6400;
    const phase = clamp((this.#idleMs - 3200) / 600, 0, 1);
    const direction = this.#idleOriginX <= 0.5 ? 1 : -1;
    const offset = 0.014 * Math.sin(phase * Math.PI) ** 2;
    this.#ix = clamp(this.#idleOriginX + direction * offset, this.#bounds.minX, this.#bounds.maxX);
  }

  #resize(layout: LayoutMetrics): void {
    const heightOffFloor = this.#bounds.maxY - this.#iy;
    const normalizedY = this.#iy / this.#layout.aspectRatio;
    this.#layout = layout;
    this.#bounds = boundsFor(layout);
    const onGlass = this.#fsm === 'INTRO_EMERGE' || this.#fsm === 'INTRO_SPLAT' || this.#fsm === 'INTRO_SLIDE';
    this.#ix = clamp(this.#ix, this.#bounds.minX, this.#bounds.maxX);
    this.#iy = onGlass ? this.#introY(normalizedY)
      : clamp(this.#bounds.maxY - heightOffFloor, this.#bounds.minY, this.#bounds.maxY);
    if (this.#fsm === 'INTRO_SLIDE') {
      this.#vy = this.#iy < this.#bounds.maxY ? INTRO_SLIDE_NORM_PER_SECOND * layout.aspectRatio : 0;
    }
    if (this.#fsm === 'DRAGGED' && this.#pointer) {
      this.#grabOffset = { x: this.#ix - this.#pointer.x, y: this.#iy - this.#pointerY(this.#pointer) };
      this.#samples = [{ x: this.#ix, y: this.#iy, timeMs: this.#context.getNowMs() }];
      this.#vx = this.#vy = 0;
    }
    this.#resetIdle();
    this.#snapshot = undefined;
  }
}
