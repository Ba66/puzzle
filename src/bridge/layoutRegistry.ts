import { DEFAULT_LAYOUT_METRICS } from '../apps/pet/brain.ts';
import type { LayoutMetrics } from '../apps/pet/brain.ts';

export interface ScreenRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

type Listener = (metrics: LayoutMetrics) => void;

const FALLBACK_WIDTH = 360;
const SLIDER_GAP_PX = 8;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function createLayoutRegistry() {
  let rect: ScreenRect = Object.freeze({
    left: 0,
    top: 0,
    width: FALLBACK_WIDTH,
    height: FALLBACK_WIDTH * DEFAULT_LAYOUT_METRICS.aspectRatio,
  });
  let metrics = DEFAULT_LAYOUT_METRICS;
  let sliderTopPx: number | undefined;
  let statusBarHeightPx: number | undefined;
  const listeners = new Set<Listener>();

  function publish(rectChanged = false) {
    const aspectRatio = rect.height / rect.width;
    const floorYNorm = sliderTopPx === undefined
      ? DEFAULT_LAYOUT_METRICS.floorYNorm
      : clamp((sliderTopPx - SLIDER_GAP_PX) / rect.height, 0.55, 0.92);
    const safeTop = statusBarHeightPx === undefined
      ? DEFAULT_LAYOUT_METRICS.topSafeNorm
      : statusBarHeightPx / rect.height;
    const topSafeNorm = clamp(safeTop, 0, floorYNorm - 0.15);
    // Retain the sprite's proportions when a wide display has unusually little vertical room.
    const scale = Math.min(1, (floorYNorm - topSafeNorm - 0.04) * aspectRatio / DEFAULT_LAYOUT_METRICS.petHeightIso);
    const petWidthIso = DEFAULT_LAYOUT_METRICS.petWidthIso * scale;
    const petHeightIso = DEFAULT_LAYOUT_METRICS.petHeightIso * scale;
    const changed = aspectRatio !== metrics.aspectRatio || floorYNorm !== metrics.floorYNorm
      || topSafeNorm !== metrics.topSafeNorm || petWidthIso !== metrics.petWidthIso || petHeightIso !== metrics.petHeightIso;
    if (changed) metrics = Object.freeze({ aspectRatio, floorYNorm, topSafeNorm, petWidthIso, petHeightIso });
    if (changed || rectChanged) {
      for (const listener of [...listeners]) listener(metrics);
    }
  }

  return {
    setScreenRect(next: ScreenRect) {
      if (![next.left, next.top, next.width, next.height].every(Number.isFinite) || next.width <= 0 || next.height <= 0) return;
      if (next.left === rect.left && next.top === rect.top && next.width === rect.width && next.height === rect.height) return;
      rect = Object.freeze({ left: next.left, top: next.top, width: next.width, height: next.height });
      publish(true);
    },
    setSliderTopPx(px: number) {
      if (!Number.isFinite(px) || px === sliderTopPx) return;
      sliderTopPx = px;
      publish();
    },
    setStatusBarHeightPx(px: number) {
      if (!Number.isFinite(px) || px < 0 || px === statusBarHeightPx) return;
      statusBarHeightPx = px;
      publish();
    },
    getRect: () => rect,
    getLayoutMetrics: () => metrics,
    clientToNormalized(clientX: number, clientY: number, { clamp: shouldClamp = true } = {}) {
      const x = (clientX - rect.left) / rect.width;
      const y = (clientY - rect.top) / rect.height;
      return shouldClamp ? { x: clamp(x, 0, 1), y: clamp(y, 0, 1) } : { x, y };
    },
    normalizedToPixel(nx: number, ny: number) {
      return { x: nx * rect.width, y: ny * rect.height };
    },
    getPetSizePx() {
      return { width: metrics.petWidthIso * rect.width, height: metrics.petHeightIso * rect.width };
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export type LayoutRegistry = ReturnType<typeof createLayoutRegistry>;
