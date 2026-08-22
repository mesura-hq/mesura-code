import { describe, expect, it } from "vite-plus/test";

import {
  normalizeClaudeAccountLimits,
  normalizeClaudeRateLimitEvent,
  normalizeCodexAccountLimits,
} from "./accountLimitsNormalize.ts";

describe("Claude account-limit normalization", () => {
  it("normalizes full and single-window payloads with the same semantics", () => {
    const full = normalizeClaudeAccountLimits({
      subscription_type: "max",
      rate_limits: {
        five_hour: { utilization: 62, resets_at: "2026-08-22T15:00:00.000Z" },
        seven_day: { utilization: 41, resets_at: "2026-08-28T17:00:00.000Z" },
      },
    });
    const single = normalizeClaudeRateLimitEvent({
      rate_limit_info: {
        rateLimitType: "five_hour",
        utilization: 62,
        resetsAt: 1_777_044_800,
      },
    });

    expect(full?.plan).toBe("max");
    expect(full?.windows.map((window) => window.id)).toEqual(["five_hour", "seven_day"]);
    expect(single).toMatchObject({ id: "five_hour", label: "5h", usedPercent: 62 });
    expect(single?.resetsAt).toBe("2026-04-24T15:33:20.000Z");
  });

  it("drops windows without utilization even when a reset is present", () => {
    expect(
      normalizeClaudeAccountLimits({
        rate_limits: {
          five_hour: { utilization: null, resets_at: "2026-08-22T15:00:00.000Z" },
        },
      })?.windows,
    ).toEqual([]);
  });

  it.each([-1, Number.MAX_VALUE])("ignores an invalid event reset timestamp: %s", (resetsAt) => {
    expect(
      normalizeClaudeRateLimitEvent({
        rate_limit_info: { rateLimitType: "five_hour", utilization: 10, resetsAt },
      }),
    ).toBeNull();
  });
});

describe("Codex account-limit normalization", () => {
  it("normalizes camelCase and snake_case windows by duration instead of slot", () => {
    const live = normalizeCodexAccountLimits({
      rateLimits: {
        limitId: "codex",
        planType: "pro",
        primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1_786_600_800 },
        secondary: { usedPercent: 14, windowDurationMins: 10_080, resetsAt: 1_786_677_720 },
      },
    });
    const transcript = normalizeCodexAccountLimits({
      limit_id: "codex",
      plan_type: "pro",
      primary: { used_percent: 14, window_minutes: 10_080, resets_at: 1_786_677_720 },
    });

    expect(live?.windows.map((window) => window.id)).toEqual(["five_hour", "seven_day"]);
    expect(transcript?.windows[0]).toMatchObject({ id: "seven_day", usedPercent: 14 });
  });

  it("clamps percentages and ignores malformed or untouched rows", () => {
    const snapshot = normalizeCodexAccountLimits({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 120, windowDurationMins: 300, resetsAt: 1_786_600_800 },
        secondary: { usedPercent: "invalid", windowDurationMins: 10_080 },
      },
    });
    const untouched = normalizeCodexAccountLimits({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: null },
      },
    });

    expect(snapshot?.windows).toHaveLength(1);
    expect(snapshot?.windows[0]?.usedPercent).toBe(100);
    expect(untouched?.windows).toEqual([]);
  });

  it("keeps the Spark meter in normalized data", () => {
    const snapshot = normalizeCodexAccountLimits({
      rateLimits: {
        limitId: "codex_bengalfox",
        limitName: "GPT-5.3-Codex-Spark",
        planType: "pro",
        primary: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: 1_786_828_412 },
      },
    });

    expect(snapshot?.windows[0]?.meter).toEqual({
      id: "codex_bengalfox",
      label: "GPT-5.3-Codex-Spark",
    });
  });

  it.each([0, -300, 12.5])("ignores an invalid window duration: %s", (windowDurationMins) => {
    expect(
      normalizeCodexAccountLimits({
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 12, windowDurationMins, resetsAt: 1_786_600_800 },
        },
      })?.windows,
    ).toEqual([]);
  });

  it.each([-1, Number.MAX_VALUE])("ignores an invalid Codex reset timestamp: %s", (resetsAt) => {
    expect(
      normalizeCodexAccountLimits({
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 12, windowDurationMins: 300, resetsAt },
        },
      })?.windows,
    ).toEqual([]);
  });
});
