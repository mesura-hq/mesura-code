/**
 * Reading scroll for the chat timeline.
 *
 * The shortcut pair behind this moves the viewport by half its own height so
 * the other half stays on screen. That remaining half is what a reader tracks
 * to keep their place; a full-viewport jump replaces everything at once and
 * costs the reader the thread they were following.
 *
 * The animation exists for the same reason and is deliberately short. Long
 * scrolls smear the text and the eye cannot hold a line through them, while an
 * instant jump gives no direction of travel at all. A brief decelerating move
 * reads as "the page moved down", which is the whole point.
 */

/** Fraction of the viewport one press travels. */
export const READING_SCROLL_VIEWPORT_FRACTION = 0.5;

/** Duration of one reading scroll, in milliseconds. */
export const READING_SCROLL_DURATION_MS = 180;

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
 * Where a press should land, clamped to the scrollable range.
 *
 * `from` lets a press that arrives mid-animation re-target off the previous
 * destination rather than off the position the animation happens to be
 * passing through. Without that, holding the key stalls: each press would
 * measure a viewport that has barely started moving and ask for a distance it
 * is already covering.
 */
export function resolveReadingScrollTarget(
  viewport: ReadingScrollViewport,
  direction: ReadingScrollDirection,
  from?: number,
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
