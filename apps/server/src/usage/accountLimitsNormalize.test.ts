import { describe, expect, it } from "vite-plus/test";

import {
  normalizeClaudeAccountLimits,
  normalizeClaudeRateLimitEvent,
  normalizeCodexAccountLimits,
  normalizeOpenCodeGoAccountLimits,
  normalizeZaiAccountLimits,
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
        utilization: 0.62,
        resetsAt: 1_777_044_800,
      },
    });

    expect(full?.plan).toBe("max");
    expect(full?.windows.map((window) => window.id)).toEqual(["five_hour", "seven_day"]);
    expect(single).toMatchObject({ id: "five_hour", label: "5h", usedPercent: 62 });
    expect(single?.resetsAt).toBe("2026-04-24T15:33:20.000Z");
  });

  it("reads a rejected window from the unified event payload", () => {
    const window = normalizeClaudeRateLimitEvent({
      rate_limit_info: {
        status: "rejected",
        rateLimitType: "five_hour",
        unifiedWindows: {
          five_hour: { utilization: 1.02, resetsAt: 1_788_750_600 },
          seven_day: { utilization: 0.76, resetsAt: 1_788_786_000 },
        },
      },
    });

    expect(window).toMatchObject({
      id: "five_hour",
      usedPercent: 100,
      resetsAt: "2026-09-07T03:10:00.000Z",
    });
  });

  it("shows a rejected window as fully used when Claude omits utilization", () => {
    expect(
      normalizeClaudeRateLimitEvent({
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: 1_788_750_600,
        },
      })?.usedPercent,
    ).toBe(100);
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
        rate_limit_info: { rateLimitType: "five_hour", utilization: 0.1, resetsAt },
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

describe("normalizeOpenCodeGoAccountLimits", () => {
  const NOW_MS = Date.parse("2026-09-02T03:00:00.000Z");
  // Captured live on 2026-09-02 from GET https://opencode.ai/zen/go/v1/usage.
  const LIVE = {
    usage: {
      rolling: { status: "ok", percent: 0, resetsAt: "2026-09-02T03:41:14.103Z" },
      weekly: { status: "ok", percent: 40, resetsAt: "2026-09-07T00:00:00.103Z" },
      monthly: { status: "ok", percent: 72, resetsAt: "2026-09-04T15:36:51.103Z" },
    },
  };

  it("reads the rolling, weekly and monthly windows the plan meters", () => {
    expect(
      normalizeOpenCodeGoAccountLimits(LIVE, NOW_MS)?.windows.map((w) => [w.id, w.usedPercent]),
    ).toEqual([
      ["five_hour", 0],
      ["seven_day", 40],
      ["thirty_day", 72],
    ]);
  });

  it("keeps each window's reset time", () => {
    expect(normalizeOpenCodeGoAccountLimits(LIVE, NOW_MS)?.windows[1]?.resetsAt).toBe(
      "2026-09-07T00:00:00.103Z",
    );
  });

  it("accepts the spelling the endpoint's own pull request documented", () => {
    // The endpoint shipped one shape and documents another, three weeks apart.
    // Accepting both is what stops the next rename emptying the panel.
    expect(
      normalizeOpenCodeGoAccountLimits(
        {
          rollingUsage: { status: "ok", usagePercent: 12, resetInSec: 3600 },
          weeklyUsage: { status: "ok", usagePercent: 34, resetInSec: 7200 },
          monthlyUsage: { status: "ok", usagePercent: 56, resetInSec: 10800 },
        },
        NOW_MS,
      )?.windows.map((w) => w.usedPercent),
    ).toEqual([12, 34, 56]);
  });

  it("drops a window whose percentage it cannot read, rather than calling it zero", () => {
    expect(
      normalizeOpenCodeGoAccountLimits(
        {
          usage: {
            rolling: { status: "ok", percentage: 40, resetsAt: "2026-09-07T00:00:00.103Z" },
            weekly: { status: "ok", percent: 40, resetsAt: "2026-09-07T00:00:00.103Z" },
          },
        },
        NOW_MS,
      )?.windows.map((w) => w.id),
    ).toEqual(["seven_day"]);
  });

  it("normalizes to nothing when it can read no window at all", () => {
    expect(normalizeOpenCodeGoAccountLimits({ usage: {} }, NOW_MS)).toBeNull();
    expect(normalizeOpenCodeGoAccountLimits({ nope: true }, NOW_MS)).toBeNull();
  });

  it("dates an offset-reported reset from the reading's own time", () => {
    // The documented spelling reports a second offset, not a time. Without the
    // reading's time it would date the reset from 1970.
    expect(
      normalizeOpenCodeGoAccountLimits(
        { rollingUsage: { status: "ok", usagePercent: 12, resetInSec: 3600 } },
        NOW_MS,
      )?.windows[0]?.resetsAt,
    ).toBe("2026-09-02T04:00:00.000Z");
  });
});

describe("normalizeZaiAccountLimits", () => {
  // Captured live on 2026-09-02 from
  // GET https://api.z.ai/api/monitor/usage/quota/limit.
  const LIVE = {
    code: 200,
    msg: "Operation successful",
    success: true,
    data: {
      level: "lite",
      limits: [
        {
          type: "CREDIT_LIMIT",
          unit: 3,
          number: 5,
          usage: 2000,
          currentValue: 1654,
          remaining: 345,
          percentage: 82,
          nextResetTime: 1788325042629,
        },
        {
          type: "CREDIT_LIMIT",
          unit: 6,
          number: 1,
          usage: 10000,
          currentValue: 2822,
          remaining: 7177,
          percentage: 28,
          nextResetTime: 1788892144998,
        },
      ],
    },
  };

  it("reads the five-hour and weekly windows from unit and multiplier", () => {
    expect(normalizeZaiAccountLimits(LIVE)?.windows.map((w) => [w.id, w.windowMinutes])).toEqual([
      ["five_hour", 300],
      ["seven_day", 10_080],
    ]);
  });

  it("takes the percentage verbatim, because usage is the cap and currentValue the spend", () => {
    // The field names are inverted from the obvious reading: `usage` is the
    // cap and `currentValue` the consumption. Recomputing would invert the bar.
    expect(normalizeZaiAccountLimits(LIVE)?.windows.map((w) => w.usedPercent)).toEqual([82, 28]);
  });

  it("reads the reset time as epoch milliseconds, not seconds", () => {
    // Claude and Codex both report seconds. Reusing that helper here would put
    // the reset fifty thousand years out.
    expect(normalizeZaiAccountLimits(LIVE)?.windows[0]?.resetsAt).toBe("2026-09-02T04:57:22.629Z");
  });

  it("reports the plan tier", () => {
    expect(normalizeZaiAccountLimits(LIVE)?.plan).toBe("Lite");
  });

  it("rejects a failed response that still answered with HTTP 200", () => {
    // A wrong path returns HTTP 200 carrying code 404. Trusting the transport
    // status would turn an error page into an empty, confident panel.
    expect(
      normalizeZaiAccountLimits({ code: 404, msg: "not found", success: false, data: null }),
    ).toBeNull();
  });

  it("falls back to a generic window for a duration unit it does not know", () => {
    expect(
      normalizeZaiAccountLimits({
        code: 200,
        success: true,
        data: {
          level: "pro",
          limits: [
            { unit: 99, number: 2, percentage: 10, nextResetTime: 1788325042629 },
            { unit: 3, number: 5, percentage: 20, nextResetTime: 1788325042629 },
          ],
        },
      })?.windows.map((w) => w.id),
    ).toEqual(["five_hour", "window_unknown_99x2"]);
  });

  it("drops a limit whose percentage it cannot read", () => {
    expect(
      normalizeZaiAccountLimits({
        code: 200,
        success: true,
        data: {
          level: "lite",
          limits: [
            { unit: 3, number: 5, percentage: "82", nextResetTime: 1788325042629 },
            { unit: 6, number: 1, percentage: 28, nextResetTime: 1788892144998 },
          ],
        },
      })?.windows.map((w) => w.id),
    ).toEqual(["seven_day"]);
  });
  it("calls a window length unknown when the multiplier is missing", () => {
    // A fabricated multiplier would render a specific, confident, wrong
    // duration — "1h" for a window nobody knows the length of.
    expect(
      normalizeZaiAccountLimits({
        code: 200,
        success: true,
        data: {
          level: "lite",
          limits: [{ unit: 3, percentage: 40, nextResetTime: 1788325042629 }],
        },
      })?.windows.map((w) => [w.id, w.windowMinutes]),
    ).toEqual([["window_unknown_3xna", null]]);
  });

  it("keeps a window the vendor reports at zero with no reset time", () => {
    // Seen live: Z.ai omits nextResetTime on a window at 0%. The Codex
    // normalizer rejects that shape because there it cannot be told from an
    // absent payload; here the percentage is explicitly present, so dropping
    // the window would lose a real row.
    expect(
      normalizeZaiAccountLimits({
        code: 200,
        success: true,
        data: { level: "lite", limits: [{ unit: 3, number: 5, percentage: 0 }] },
      })?.windows.map((w) => [w.id, w.usedPercent, w.resetsAt]),
    ).toEqual([["five_hour", 0, null]]);
  });
});
