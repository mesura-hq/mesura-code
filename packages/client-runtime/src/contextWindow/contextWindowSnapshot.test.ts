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

  it("formats millions with a capital M in the shared formatter", () => {
    expect(formatContextWindowTokens(1_000_000)).toBe("1M");
    expect(formatContextWindowTokens(1_500_000)).toBe("1.5M");
    expect(formatContextWindowTokens(272_000)).toBe("272k");
  });
});
