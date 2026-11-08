import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ThreadTokenUsageSnapshot } from "./providerRuntime.ts";
const decodeThreadTokenUsageSnapshot = Schema.decodeUnknownSync(ThreadTokenUsageSnapshot);

describe("ThreadTokenUsageSnapshot", () => {
  it("accepts the Claude cache-write fields on a context snapshot", () => {
    expect(
      decodeThreadTokenUsageSnapshot({
        usedTokens: 64600,
        inputTokens: 64500,
        cachedInputTokens: 63500,
        cacheCreationTokens: 600,
        lastCacheCreationTokens: 600,
      }),
    ).toMatchObject({ cacheCreationTokens: 600, lastCacheCreationTokens: 600 });
  });

  it("refuses negative or fractional Claude cache-write counts", () => {
    for (const field of ["cacheCreationTokens", "lastCacheCreationTokens"]) {
      expect(() => decodeThreadTokenUsageSnapshot({ usedTokens: 1, [field]: -1 })).toThrow();
      expect(() => decodeThreadTokenUsageSnapshot({ usedTokens: 1, [field]: 1.5 })).toThrow();
    }
  });
});
