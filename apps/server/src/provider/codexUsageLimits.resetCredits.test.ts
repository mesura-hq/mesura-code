import { describe, expect, it } from "vite-plus/test";

import { codexRateLimitsToLimits } from "./codexUsageLimits.ts";

const CHECKED_AT = "2026-11-04T01:00:00.000Z";

describe("codexRateLimitsToLimits reset credits", () => {
  it("lists each available credit's expiry, soonest first", () => {
    const limits = codexRateLimitsToLimits({
      snapshot: { limitId: "codex" },
      checkedAt: CHECKED_AT,
      resetCredits: {
        availableCount: 3,
        credits: [
          { status: "available", expiresAt: 1_796_163_754 },
          { status: "consumed", expiresAt: 1_790_000_000 },
          { status: "available", expiresAt: 1_794_007_073 },
          { status: "available", expiresAt: null },
        ],
      },
    });

    expect(limits.resetCredits).toEqual({
      availableCount: 3,
      nextExpiresAt: "2026-11-06T23:17:53.000Z",
      expiries: ["2026-11-06T23:17:53.000Z", "2026-12-01T22:22:34.000Z"],
    });
  });

  it("omits the list when no credit carries an expiry", () => {
    const limits = codexRateLimitsToLimits({
      snapshot: { limitId: "codex" },
      checkedAt: CHECKED_AT,
      resetCredits: { availableCount: 0, credits: [] },
    });

    expect(limits.resetCredits).toEqual({ availableCount: 0 });
  });
});
