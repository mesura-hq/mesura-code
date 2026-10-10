/**
 * Phase 3 fence: the snapshot half of the shared context-window module.
 * Entry point: `deriveLatestContextWindowSnapshot` and
 * `formatContextWindowTokens` from the public subpath
 * `@t3tools/client-runtime/context-window`, the functions both clients call.
 */
import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import {
  deriveLatestContextWindowSnapshot,
  formatContextWindowTokens,
} from "@t3tools/client-runtime/context-window";

function makeContextWindowActivity(payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make("activity-1"),
    tone: "info",
    kind: "context-window.updated",
    summary: "Context updated",
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-10-04T00:00:00.000Z",
  };
}

describe("shared context-window snapshot", () => {
  it("carries the cache-creation pair from the activity payload", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeContextWindowActivity({
        usedTokens: 64_223,
        maxTokens: 200_000,
        inputTokens: 64_223,
        cachedInputTokens: 63_500,
        cacheCreationTokens: 600,
        lastCacheCreationTokens: 500,
      }),
    ]);

    expect(snapshot?.cacheCreationTokens).toBe(600);
    expect(snapshot?.lastCacheCreationTokens).toBe(500);
  });

  it("leaves the cache-creation pair null when the payload omits it", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeContextWindowActivity({ usedTokens: 14_000, maxTokens: 258_000 }),
    ]);

    expect(snapshot?.cacheCreationTokens).toBeNull();
    expect(snapshot?.lastCacheCreationTokens).toBeNull();
  });

  it("formats millions with a capital M in the shared formatter", () => {
    expect(formatContextWindowTokens(1_000_000)).toBe("1M");
    expect(formatContextWindowTokens(1_500_000)).toBe("1.5M");
    expect(formatContextWindowTokens(272_000)).toBe("272k");
  });
});
