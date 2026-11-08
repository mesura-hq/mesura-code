/**
 * Phase 3 fence: the snapshot half of the shared context-window module.
 * Entry point: `deriveLatestContextWindowSnapshot` and
 * `formatContextWindowTokens` from the public subpath
 * `@t3tools/client-runtime/context-window`.
 */
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveLatestContextWindowSnapshot,
  formatContextWindowTokens,
} from "@t3tools/client-runtime/context-window";

const UPDATED_AT = DateTime.makeUnsafe("2026-10-04T00:00:00.000Z");

describe("shared context-window snapshot", () => {
  it("carries the cache-creation pair from the provider thread's usage", () => {
    const snapshot = deriveLatestContextWindowSnapshot([], null, {
      contextUsage: {
        usedTokens: 64_223,
        maxTokens: 200_000,
        inputTokens: 64_223,
        cachedInputTokens: 63_500,
        cacheCreationTokens: 600,
        lastCacheCreationTokens: 500,
      },
      updatedAt: UPDATED_AT,
    });

    expect(snapshot?.cacheCreationTokens).toBe(600);
    expect(snapshot?.lastCacheCreationTokens).toBe(500);
  });

  it("leaves the cache-creation pair null when the usage omits it", () => {
    const snapshot = deriveLatestContextWindowSnapshot([], null, {
      contextUsage: { usedTokens: 14_000, maxTokens: 258_000 },
      updatedAt: UPDATED_AT,
    });

    expect(snapshot?.cacheCreationTokens).toBeNull();
    expect(snapshot?.lastCacheCreationTokens).toBeNull();
  });

  it("measures the used share against the auto-compact threshold, not the model window", () => {
    const live = deriveLatestContextWindowSnapshot([], {
      usedTokens: 537_750,
      maxTokens: 1_000_000,
      autoCompactThreshold: 717_000,
      updatedAt: "2026-10-04T00:00:00.000Z",
    });
    const persisted = deriveLatestContextWindowSnapshot([], null, {
      contextUsage: { usedTokens: 537_750, maxTokens: 1_000_000, autoCompactThreshold: 717_000 },
      updatedAt: UPDATED_AT,
    });

    for (const snapshot of [live, persisted]) {
      expect(snapshot?.maxTokens).toBe(1_000_000);
      expect(snapshot?.usedPercentage).toBe(75);
      expect(snapshot?.remainingTokens).toBe(179_250);
      expect(snapshot?.remainingPercentage).toBe(25);
    }
  });

  it("falls back to the model window when no threshold is reported", () => {
    const snapshot = deriveLatestContextWindowSnapshot([], {
      usedTokens: 250_000,
      maxTokens: 1_000_000,
      updatedAt: "2026-10-04T00:00:00.000Z",
    });

    expect(snapshot?.usedPercentage).toBe(25);
    expect(snapshot?.remainingTokens).toBe(750_000);
  });

  it("formats millions with a capital M in the shared formatter", () => {
    expect(formatContextWindowTokens(1_000_000)).toBe("1M");
    expect(formatContextWindowTokens(1_500_000)).toBe("1.5M");
    expect(formatContextWindowTokens(272_000)).toBe("272k");
  });
});
