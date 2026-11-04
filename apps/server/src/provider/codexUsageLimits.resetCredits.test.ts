import { describe, expect, it } from "vite-plus/test";

import { applyUsageLimitsUpdate } from "@t3tools/provider-core/server/usageLimits";

import { codexRateLimitsToLimits, codexRateLimitsToUpdate } from "./codexUsageLimits.ts";

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
      readAt: CHECKED_AT,
    });
  });

  it("sends an empty list when available credits carry no expiry", () => {
    const limits = codexRateLimitsToLimits({
      snapshot: { limitId: "codex" },
      checkedAt: CHECKED_AT,
      resetCredits: {
        availableCount: 2,
        credits: [{ status: "available", expiresAt: null }, { status: "available" }],
      },
    });

    expect(limits.resetCredits).toEqual({ availableCount: 2, expiries: [], readAt: CHECKED_AT });
  });

  it("omits the list when no credit is available", () => {
    const limits = codexRateLimitsToLimits({
      snapshot: { limitId: "codex" },
      checkedAt: CHECKED_AT,
      resetCredits: { availableCount: 0, credits: [] },
    });

    expect(limits.resetCredits).toEqual({ availableCount: 0, readAt: CHECKED_AT });
  });

  it("keeps the credits' read time when a window-only event advances checkedAt", () => {
    const probed = codexRateLimitsToLimits({
      snapshot: { limitId: "codex", primary: { usedPercent: 10, windowDurationMins: 10_080 } },
      checkedAt: CHECKED_AT,
      resetCredits: { availableCount: 1, credits: [{ status: "available", expiresAt: null }] },
    });
    const update = codexRateLimitsToUpdate({
      limitId: "codex",
      primary: { usedPercent: 20, windowDurationMins: 10_080 },
    });
    const updated = applyUsageLimitsUpdate({
      previous: probed,
      update: update!,
      checkedAt: "2026-11-04T02:00:00.000Z",
    });

    expect(updated?.checkedAt).toBe("2026-11-04T02:00:00.000Z");
    expect(updated?.resetCredits?.readAt).toBe(CHECKED_AT);
  });
});
