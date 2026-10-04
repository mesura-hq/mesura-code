/**
 * Phase 5: the presentation helpers both the web pill and the Android
 * indicator read, moved here so neither client keeps its own copy. Entry
 * point: the public subpath `@t3tools/client-runtime/context-window`.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  CONTEXT_WINDOW_RING_CIRCUMFERENCE,
  CONTEXT_WINDOW_RING_RADIUS,
  CONTEXT_WINDOW_RING_SEGMENT_GAP,
  deriveContextWindowCacheSplit,
  deriveContextWindowRingArcs,
  deriveContextWindowRequestBreakdown,
  formatContextWindowAccessibilityLabel,
  formatContextWindowUsedPercentage,
  isContextWindowCacheCold,
} from "@t3tools/client-runtime/context-window";

const NO_USAGE_FIELDS = {
  inputTokens: null,
  cachedInputTokens: null,
  cacheCreationTokens: null,
  outputTokens: null,
  reasoningOutputTokens: null,
  lastInputTokens: null,
  lastCachedInputTokens: null,
  lastCacheCreationTokens: null,
  lastOutputTokens: null,
  lastReasoningOutputTokens: null,
} as const;

function breakdownOf(fields: Partial<Record<keyof typeof NO_USAGE_FIELDS, number>>) {
  const breakdown = deriveContextWindowRequestBreakdown({ ...NO_USAGE_FIELDS, ...fields });
  if (!breakdown) throw new Error("fixture produced no breakdown");
  return breakdown;
}

describe("context-window used percentage label", () => {
  it("prints one decimal below ten percent and drops a trailing zero", () => {
    expect(formatContextWindowUsedPercentage(6.54)).toBe("6.5%");
    expect(formatContextWindowUsedPercentage(4)).toBe("4%");
  });

  it("rounds to a whole percent from ten percent up", () => {
    expect(formatContextWindowUsedPercentage(24.4)).toBe("24%");
  });

  it("returns null for an unknown share", () => {
    expect(formatContextWindowUsedPercentage(null)).toBe(null);
    expect(formatContextWindowUsedPercentage(Number.NaN)).toBe(null);
  });
});

describe("context-window indicator accessibility label", () => {
  it("gives the used share when the window total is known", () => {
    expect(
      formatContextWindowAccessibilityLabel({
        usedTokens: 240_000,
        maxTokens: 1_000_000,
        usedPercentage: 24,
      }),
    ).toBe("Context window 24% used");
  });

  it("gives the used token count when the window total is unknown", () => {
    expect(
      formatContextWindowAccessibilityLabel({
        usedTokens: 65_000,
        maxTokens: null,
        usedPercentage: null,
      }),
    ).toBe("Context window 65k tokens used");
  });
});

describe("context-window ring arcs", () => {
  it("keeps the plan's ring geometry: radius 9.75 in a 24 viewBox, 0.9 between arcs", () => {
    expect(CONTEXT_WINDOW_RING_RADIUS).toBe(9.75);
    expect(CONTEXT_WINDOW_RING_SEGMENT_GAP).toBe(0.9);
    expect(CONTEXT_WINDOW_RING_CIRCUMFERENCE).toBeCloseTo(2 * Math.PI * 9.75);
  });

  it("lays arcs end to end and trims the gap from each", () => {
    const arcs = deriveContextWindowRingArcs([
      { kind: "cacheRead", tokens: 50, fraction: 0.5 },
      { kind: "output", tokens: 25, fraction: 0.25 },
    ]);
    expect(arcs).toEqual([
      {
        kind: "cacheRead",
        start: 0,
        visibleLength: 0.5 * CONTEXT_WINDOW_RING_CIRCUMFERENCE - CONTEXT_WINDOW_RING_SEGMENT_GAP,
      },
      {
        kind: "output",
        start: 0.5 * CONTEXT_WINDOW_RING_CIRCUMFERENCE,
        visibleLength: 0.25 * CONTEXT_WINDOW_RING_CIRCUMFERENCE - CONTEXT_WINDOW_RING_SEGMENT_GAP,
      },
    ]);
  });

  it("drops an arc shorter than the gap but keeps its place on the ring", () => {
    const arcs = deriveContextWindowRingArcs([
      { kind: "cacheWrite", tokens: 1, fraction: 0.001 },
      { kind: "output", tokens: 25, fraction: 0.25 },
    ]);
    expect(arcs.map((arc) => arc.kind)).toEqual(["output"]);
    expect(arcs[0]?.start).toBeCloseTo(0.001 * CONTEXT_WINDOW_RING_CIRCUMFERENCE);
  });

  it("draws a single segment without a gap", () => {
    const arcs = deriveContextWindowRingArcs([{ kind: "input", tokens: 10, fraction: 0.1 }]);
    expect(arcs[0]?.visibleLength).toBeCloseTo(0.1 * CONTEXT_WINDOW_RING_CIRCUMFERENCE);
  });
});

describe("context-window dotted cache split", () => {
  it("names cache read, write and new input for a provider with cache writes", () => {
    expect(
      deriveContextWindowCacheSplit(
        breakdownOf({ inputTokens: 65_000, cachedInputTokens: 60_000, cacheCreationTokens: 2_000 }),
      ),
    ).toEqual([
      { kind: "cacheRead", text: "cache read 60k" },
      { kind: "cacheWrite", text: "write 2k" },
      { kind: "uncached", text: "new 3k" },
    ]);
  });

  it("says cached when the provider reports no cache writes", () => {
    expect(
      deriveContextWindowCacheSplit(
        breakdownOf({ inputTokens: 65_000, cachedInputTokens: 60_000 }),
      ),
    ).toEqual([
      { kind: "cacheRead", text: "cached 60k" },
      { kind: "uncached", text: "new 5k" },
    ]);
  });

  it("is empty when the provider reports no cache split", () => {
    expect(deriveContextWindowCacheSplit(breakdownOf({ inputTokens: 65_000 }))).toEqual([]);
  });
});

describe("context-window cold cache rule", () => {
  it("is cold below fifty percent cached and warm at fifty", () => {
    expect(
      isContextWindowCacheCold(breakdownOf({ inputTokens: 1_000, cachedInputTokens: 499 })),
    ).toBe(true);
    expect(
      isContextWindowCacheCold(breakdownOf({ inputTokens: 1_000, cachedInputTokens: 500 })),
    ).toBe(false);
  });

  it("is never cold when the provider reports no cache split", () => {
    expect(isContextWindowCacheCold(breakdownOf({ inputTokens: 1_000 }))).toBe(false);
  });
});
