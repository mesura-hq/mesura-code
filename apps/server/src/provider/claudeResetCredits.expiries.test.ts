import { describe, expect, it } from "vite-plus/test";

import { claudeResetCreditsToContract } from "./claudeResetCredits.ts";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");

describe("claudeResetCreditsToContract expiries", () => {
  it("lists one date per reset a grant holds, soonest first", () => {
    expect(
      claudeResetCreditsToContract(
        {
          eligible: true,
          next_grant_id: "late",
          grants: [
            { id: "late", resets_left: 1, usable_now: true, ends_at: "2026-11-01T00:00:00Z" },
            { id: "soon", resets_left: 2, usable_now: true, ends_at: "2026-10-01T00:00:00Z" },
            { id: "undated", resets_left: 1, usable_now: true },
          ],
        },
        NOW,
      )?.expiries,
    ).toEqual(["2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"]);
  });

  it("sends an empty list when every usable grant is undated", () => {
    expect(
      claudeResetCreditsToContract(
        {
          eligible: true,
          next_grant_id: "a",
          grants: [{ id: "a", resets_left: 2, usable_now: true }],
        },
        NOW,
      ),
    ).toEqual({
      availableCount: 2,
      nextCreditId: "a",
      expiries: [],
      readAt: "2026-09-22T12:00:00.000Z",
    });
  });
});
