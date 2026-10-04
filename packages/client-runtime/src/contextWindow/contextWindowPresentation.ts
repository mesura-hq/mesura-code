import {
  COLD_CACHE_PERCENTAGE,
  type ContextWindowRequestBreakdown,
  type ContextWindowSegment,
  type ContextWindowSegmentKind,
} from "./contextWindowRequest.ts";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "./contextWindowSnapshot.ts";

/**
 * The used share as the indicator prints it: one decimal below 10%, whole
 * percent above. `null` when the share is unknown.
 */
export function formatContextWindowUsedPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

/**
 * The screen-reader label of the composer indicator: the used share when the
 * window total is known, the used token count otherwise.
 */
export function formatContextWindowAccessibilityLabel(
  usage: Pick<ContextWindowSnapshot, "usedTokens" | "maxTokens" | "usedPercentage">,
): string {
  const usedPercentage = formatContextWindowUsedPercentage(usage.usedPercentage);
  return usage.maxTokens !== null && usedPercentage
    ? `Context window ${usedPercentage} used`
    : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`;
}

/** Ring geometry in a 24-unit viewBox, shared by the web SVG and the native one. */
export const CONTEXT_WINDOW_RING_RADIUS = 9.75;
export const CONTEXT_WINDOW_RING_CIRCUMFERENCE = 2 * Math.PI * CONTEXT_WINDOW_RING_RADIUS;
/** Gap between neighbouring arcs, in viewBox units, so adjacent colours stay distinct. */
export const CONTEXT_WINDOW_RING_SEGMENT_GAP = 0.9;

export interface ContextWindowRingArc {
  readonly kind: ContextWindowSegmentKind;
  /** Distance along the circle where the arc starts; use as a negative dash offset. */
  readonly start: number;
  readonly visibleLength: number;
}

/**
 * One arc per segment, clockwise from the start of the stroke, drawn to true
 * scale: a segment shorter than the gap is dropped.
 */
export function deriveContextWindowRingArcs(
  segments: ReadonlyArray<ContextWindowSegment>,
): ReadonlyArray<ContextWindowRingArc> {
  const gap = segments.length > 1 ? CONTEXT_WINDOW_RING_SEGMENT_GAP : 0;
  let offset = 0;
  const arcs: ContextWindowRingArc[] = [];
  for (const segment of segments) {
    const length = segment.fraction * CONTEXT_WINDOW_RING_CIRCUMFERENCE;
    const visibleLength = Math.max(0, length - gap);
    if (visibleLength > 0) {
      arcs.push({ kind: segment.kind, start: offset, visibleLength });
    }
    offset += length;
  }
  return arcs;
}

export interface ContextWindowCacheSplitPart {
  readonly kind: ContextWindowSegmentKind;
  readonly text: string;
}

/**
 * The dotted line under "Input": `cache read 60k · write 2k · new 3k`. A
 * provider without cache writes gets `cached` instead of `cache read`. Empty
 * when the provider reports no cache split.
 */
export function deriveContextWindowCacheSplit(
  breakdown: ContextWindowRequestBreakdown,
): ReadonlyArray<ContextWindowCacheSplitPart> {
  if (breakdown.cacheReadTokens === null) {
    return [];
  }
  const hasCacheWrites = breakdown.cacheWriteTokens !== null;
  return [
    {
      kind: "cacheRead",
      text: `${hasCacheWrites ? "cache read" : "cached"} ${formatContextWindowTokens(breakdown.cacheReadTokens)}`,
    },
    ...(breakdown.cacheWriteTokens === null
      ? []
      : [
          {
            kind: "cacheWrite" as const,
            text: `write ${formatContextWindowTokens(breakdown.cacheWriteTokens)}`,
          },
        ]),
    { kind: "uncached", text: `new ${formatContextWindowTokens(breakdown.uncachedTokens)}` },
  ];
}

export function isContextWindowCacheCold(breakdown: ContextWindowRequestBreakdown): boolean {
  return breakdown.cachedPercentage !== null && breakdown.cachedPercentage < COLD_CACHE_PERCENTAGE;
}

export const CONTEXT_WINDOW_COLD_CACHE_MESSAGE =
  "Cache was cold: this request paid full price for most of its input.";
