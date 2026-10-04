/**
 * Phase 3 fence, acceptance criteria 1–6: the shared context-window logic the
 * web pill and the Android indicator both read. Entry point: the public subpath
 * `@t3tools/client-runtime/context-window`, imported by name so the export
 * surface itself is under test. Expected values are written out from the
 * approved plan, never computed from the module under test.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  COLD_CACHE_PERCENTAGE,
  CONTEXT_WINDOW_SEGMENT_LABELS,
  deriveContextWindowRequestBreakdown,
  deriveContextWindowRequestSegments,
  deriveContextWindowSegments,
  deriveLatestContextWindowSnapshot,
  formatContextWindowCachedPercentage,
  formatContextWindowIndicatorLabels,
  formatContextWindowTokens,
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

describe("context-window public subpath (criterion 1)", () => {
  it("exports the snapshot, formatting, label, breakdown and segment helpers", () => {
    expect(typeof deriveLatestContextWindowSnapshot).toBe("function");
    expect(typeof formatContextWindowTokens).toBe("function");
    expect(typeof formatContextWindowIndicatorLabels).toBe("function");
    expect(typeof deriveContextWindowRequestBreakdown).toBe("function");
    expect(typeof deriveContextWindowSegments).toBe("function");
    expect(COLD_CACHE_PERCENTAGE).toBe(50);
    expect(CONTEXT_WINDOW_SEGMENT_LABELS).toEqual({
      cacheRead: "Cache read",
      cacheWrite: "Cache write",
      uncached: "New",
      input: "Input",
      output: "Output",
    });
  });
});

describe("context-window token labels (criterion 2)", () => {
  it("formats one million tokens as 1M with a capital M", () => {
    expect(formatContextWindowTokens(1_000_000)).toBe("1M");
  });

  it("labels the pill 65k and 1M for 65,000 used of 1,000,000", () => {
    expect(
      formatContextWindowIndicatorLabels({ usedTokens: 65_000, maxTokens: 1_000_000 }),
    ).toEqual({ used: "65k", max: "1M" });
  });

  it("gives the pill no max label when the window total is unknown", () => {
    expect(formatContextWindowIndicatorLabels({ usedTokens: 65_000, maxTokens: null })).toEqual({
      used: "65k",
      max: null,
    });
  });
});

describe("context-window request breakdown (criteria 3 and 4)", () => {
  it("splits a Codex-shaped request into 99% cached, no cache write and 1,000 new", () => {
    const breakdown = deriveContextWindowRequestBreakdown({
      ...NO_USAGE_FIELDS,
      lastInputTokens: 219_000,
      lastCachedInputTokens: 218_000,
    });

    expect(breakdown).not.toBeNull();
    expect(breakdown?.inputTokens).toBe(219_000);
    expect(breakdown?.cacheReadTokens).toBe(218_000);
    expect(breakdown?.cacheWriteTokens).toBeNull();
    expect(breakdown?.uncachedTokens).toBe(1_000);
    expect(breakdown?.cachedPercentage).toBeGreaterThanOrEqual(99);
    expect(breakdown?.cachedPercentage).toBeLessThan(100);
    expect(formatContextWindowCachedPercentage(breakdown?.cachedPercentage ?? 0)).toBe("99%");
  });

  it("floors the displayed cached share so 100% means nothing was new", () => {
    expect(formatContextWindowCachedPercentage((218_000 / 219_000) * 100)).toBe("99%");
    expect(formatContextWindowCachedPercentage(100)).toBe("100%");
    expect(formatContextWindowCachedPercentage(49.9)).toBe("49%");
    expect(formatContextWindowCachedPercentage(0)).toBe("0%");
  });

  it("splits a Claude-shaped request from the plain fields into cache write 600 and 123 new", () => {
    const breakdown = deriveContextWindowRequestBreakdown({
      ...NO_USAGE_FIELDS,
      inputTokens: 64_223,
      cachedInputTokens: 63_500,
      cacheCreationTokens: 600,
    });

    expect(breakdown).not.toBeNull();
    expect(breakdown?.inputTokens).toBe(64_223);
    expect(breakdown?.cacheReadTokens).toBe(63_500);
    expect(breakdown?.cacheWriteTokens).toBe(600);
    expect(breakdown?.uncachedTokens).toBe(123);
  });

  it("reports null cache fields, not zeros, when the provider reports no cached input", () => {
    const breakdown = deriveContextWindowRequestBreakdown({
      ...NO_USAGE_FIELDS,
      inputTokens: 64_223,
      outputTokens: 900,
    });

    expect(breakdown).not.toBeNull();
    expect(breakdown?.inputTokens).toBe(64_223);
    expect(breakdown?.outputTokens).toBe(900);
    expect(breakdown?.cacheReadTokens).toBeNull();
    expect(breakdown?.cacheWriteTokens).toBeNull();
    expect(breakdown?.uncachedTokens).toBeNull();
    expect(breakdown?.cachedPercentage).toBeNull();
  });
});

describe("context-window ring segments (criteria 5 and 6)", () => {
  const claudeShapedUsage = {
    ...NO_USAGE_FIELDS,
    usedTokens: 48_000,
    maxTokens: 200_000,
    inputTokens: 45_900 + 800 + 400,
    cachedInputTokens: 45_900,
    cacheCreationTokens: 800,
    outputTokens: 900,
  };

  it("orders the segments cache read, write, new, output and sums them to the 0.24 used share", () => {
    const segments = deriveContextWindowSegments(claudeShapedUsage);

    expect(segments.map((segment) => segment.kind)).toEqual([
      "cacheRead",
      "cacheWrite",
      "uncached",
      "output",
    ]);
    expect(segments.map((segment) => segment.tokens)).toEqual([45_900, 800, 400, 900]);
    const usedShare = segments.reduce((sum, segment) => sum + segment.fraction, 0);
    expect(usedShare).toBeCloseTo(0.24, 10);
  });

  it("drops a segment whose part is zero", () => {
    const segments = deriveContextWindowSegments({
      ...claudeShapedUsage,
      inputTokens: 45_900 + 400,
      cacheCreationTokens: 0,
    });

    expect(segments.map((segment) => segment.kind)).toEqual(["cacheRead", "uncached", "output"]);
    const usedShare = segments.reduce((sum, segment) => sum + segment.fraction, 0);
    expect(usedShare).toBeCloseTo(0.24, 10);
  });

  it("yields no segments when the window total is unknown", () => {
    expect(deriveContextWindowSegments({ ...claudeShapedUsage, maxTokens: null })).toEqual([]);
  });

  it("yields one input and one output segment for a provider without a cache split", () => {
    const segments = deriveContextWindowSegments({
      ...NO_USAGE_FIELDS,
      usedTokens: 48_000,
      maxTokens: 200_000,
      inputTokens: 47_100,
      outputTokens: 900,
    });

    expect(segments.map((segment) => segment.kind)).toEqual(["input", "output"]);
    expect(segments.map((segment) => segment.tokens)).toEqual([47_100, 900]);
    const usedShare = segments.reduce((sum, segment) => sum + segment.fraction, 0);
    expect(usedShare).toBeCloseTo(0.24, 10);
  });
});

describe("context-window request composition without a window total", () => {
  it("gives the request bar an input and an output part when the provider reports no total", () => {
    const usage = {
      ...NO_USAGE_FIELDS,
      usedTokens: 65_000,
      maxTokens: null,
      inputTokens: 64_500,
      outputTokens: 500,
    };

    const requestSegments = deriveContextWindowRequestSegments(usage);

    expect(requestSegments.map((segment) => segment.kind)).toEqual(["input", "output"]);
    expect(requestSegments.map((segment) => segment.tokens)).toEqual([64_500, 500]);
    const requestShare = requestSegments.reduce((sum, segment) => sum + segment.fraction, 0);
    expect(requestShare).toBeCloseTo(1, 10);
    expect(deriveContextWindowSegments(usage)).toEqual([]);
  });

  it("scales a cache-split request to the whole bar in ring order, dropping zero parts", () => {
    const requestSegments = deriveContextWindowRequestSegments({
      ...NO_USAGE_FIELDS,
      inputTokens: 45_900 + 400,
      cachedInputTokens: 45_900,
      cacheCreationTokens: 0,
      outputTokens: 900,
    });

    expect(requestSegments.map((segment) => segment.kind)).toEqual([
      "cacheRead",
      "uncached",
      "output",
    ]);
    const requestShare = requestSegments.reduce((sum, segment) => sum + segment.fraction, 0);
    expect(requestShare).toBeCloseTo(1, 10);
  });

  it("gives the request bar no parts when the provider reports no input", () => {
    expect(deriveContextWindowRequestSegments({ ...NO_USAGE_FIELDS, outputTokens: 500 })).toEqual(
      [],
    );
  });
});
