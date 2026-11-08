/**
 * One press moves half the viewport so the other half stays on screen for the reader to
 * keep their place. The animation is short on purpose: a long scroll smears the text,
 * and an instant jump shows no direction of travel.
 */

/** Fraction of the viewport one press travels. */
const READING_SCROLL_VIEWPORT_FRACTION = 0.5;

/** Duration of one reading scroll, in milliseconds. */
export const READING_SCROLL_DURATION_MS = 180;

/**
 * Below this the readable height is treated as unmeasurable rather than tiny.
 * A composer tall enough to cover the timeline would otherwise drive the
 * travel distance to zero and turn both shortcuts into silent no-ops.
 */
export const MIN_READABLE_HEIGHT = 80;

export type ReadingScrollDirection = "up" | "down";

export interface ReadingScrollViewport {
  /** Current distance from the top of the scrollable content. */
  readonly scrollTop: number;
  /**
   * Height of the area a reader can actually read. The composer floats over
   * the bottom of the timeline, so this is smaller than the scroll container:
   * measuring the container instead would move more than half the readable
   * text and eat into the overlap the shortcut exists to preserve.
   */
  readonly visibleHeight: number;
  /** Largest valid scrollTop, that is content height minus container height. */
  readonly maxScrollTop: number;
}

/**
 * Decelerating curve. Fast at the start so the move registers immediately,
 * slow at the end so the text settles instead of snapping to a stop.
 */
export function easeOutCubic(progress: number): number {
  const clamped = Math.min(1, Math.max(0, progress));
  return 1 - (1 - clamped) ** 3;
}

export function readingScrollDistance(visibleHeight: number): number {
  if (!Number.isFinite(visibleHeight) || visibleHeight <= 0) return 0;
  return visibleHeight * READING_SCROLL_VIEWPORT_FRACTION;
}

/**
 * `from` lets a press that arrives mid-animation re-target off the previous destination.
 * Measuring from the animating position instead stalls a held key, because each press
 * asks for a distance the animation is already covering.
 */
export function resolveReadingScrollTarget(
  viewport: ReadingScrollViewport,
  direction: ReadingScrollDirection,
  from: number | null = null,
): number {
  const maxScrollTop = Math.max(0, viewport.maxScrollTop);
  const origin = Math.min(maxScrollTop, Math.max(0, from ?? viewport.scrollTop));
  const distance = readingScrollDistance(viewport.visibleHeight);
  const unclamped = direction === "up" ? origin - distance : origin + distance;
  return Math.min(maxScrollTop, Math.max(0, unclamped));
}

export function readingScrollPositionAt(
  fromScrollTop: number,
  toScrollTop: number,
  elapsedMs: number,
  durationMs = READING_SCROLL_DURATION_MS,
): number {
  if (durationMs <= 0) return toScrollTop;
  const eased = easeOutCubic(elapsedMs / durationMs);
  return fromScrollTop + (toScrollTop - fromScrollTop) * eased;
}
