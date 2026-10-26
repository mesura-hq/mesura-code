// Entry point: the provider-reading parsers and `factoryRunUsageProvider` from
// `@t3tools/shared/factoryRunUsage`, which the server's run usage reader composes.
import { describe, expect, it } from "vite-plus/test";

import {
  factoryQuotaMovement,
  factoryQuotaWindows,
  factoryRunSpendBetween,
  factoryRunUsageProvider,
  readClaudeQuotaLine,
  readCodexQuotaLine,
  type FactoryQuotaSample,
} from "./factoryRunUsage.ts";

// A line of a real `claude -p --output-format stream-json` output (thread-attention, 2026-10-24).
const CLAUDE_LINE = JSON.stringify({
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    resetsAt: 1792829400,
    rateLimitType: "five_hour",
    unifiedWindows: {
      five_hour: { utilization: 0.06, resetsAt: 1792829400 },
      seven_day: { utilization: 0.16, resetsAt: 1793019600 },
    },
  },
  session_id: "df1c8b08-4ee2-4ecd-a9c3-5ab78b5c273f",
});

// The shape of a Codex session rollout line with rate limits (codex-cli 0.159).
const CODEX_LINE = JSON.stringify({
  timestamp: "2026-10-24T22:53:43.733Z",
  type: "event_msg",
  payload: {
    type: "token_count",
    rate_limits: {
      limit_id: "codex",
      primary: { used_percent: 14.0, window_minutes: 10080, resets_at: 1793382080 },
      secondary: null,
      plan_type: "pro",
    },
  },
});

const sample = (
  usedPercent: number,
  minute: number,
  resetsAtMs: number | null = 1_000,
): FactoryQuotaSample => ({
  provider: "claude",
  window: "seven_day",
  usedPercent,
  resetsAtMs,
  observedAtMs: minute * 60_000,
});

describe("provider readings", () => {
  it("reads every unified window of a Claude rate limit event as a percent", () => {
    expect(readClaudeQuotaLine(CLAUDE_LINE, 5)).toEqual([
      {
        provider: "claude",
        window: "five_hour",
        usedPercent: 6,
        resetsAtMs: 1792829400000,
        observedAtMs: 5,
      },
      {
        provider: "claude",
        window: "seven_day",
        usedPercent: 16,
        resetsAtMs: 1793019600000,
        observedAtMs: 5,
      },
    ]);
  });

  it("reads an older Claude event that carries only its own window", () => {
    const line = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { rateLimitType: "seven_day", utilization: 0.42, resetsAt: 10 },
    });
    expect(readClaudeQuotaLine(line, 1)).toEqual([
      {
        provider: "claude",
        window: "seven_day",
        usedPercent: 42,
        resetsAtMs: 10_000,
        observedAtMs: 1,
      },
    ]);
  });

  it("reads a Codex rollout's weekly window by its length and the line's own time", () => {
    expect(readCodexQuotaLine(CODEX_LINE)).toEqual([
      {
        provider: "codex",
        window: "seven_day",
        usedPercent: 14,
        resetsAtMs: 1793382080000,
        observedAtMs: Date.parse("2026-10-24T22:53:43.733Z"),
      },
    ]);
  });

  it("ignores lines that are not readings or not JSON", () => {
    expect(readClaudeQuotaLine('{"type":"assistant"}', 0)).toEqual([]);
    expect(readClaudeQuotaLine('{"type":"rate_limit_event"', 0)).toEqual([]);
    expect(readCodexQuotaLine('{"payload":{"rate_limits":null}}')).toEqual([]);
  });
});

describe("account movement", () => {
  it("adds the climbs in time order", () => {
    expect(factoryQuotaMovement([sample(24, 30), sample(16, 0), sample(18, 10)])).toMatchObject({
      firstPercent: 16,
      lastPercent: 24,
      movedPercent: 8,
      samples: 3,
      resets: 0,
    });
  });

  it("starts a new baseline at a drop or a changed reset time, without subtracting", () => {
    expect(
      factoryQuotaMovement([sample(40, 0), sample(42, 10), sample(10, 20), sample(13, 30)]),
    ).toMatchObject({ movedPercent: 5, resets: 1 });
    expect(
      factoryQuotaMovement([sample(90, 0), sample(2, 10, 9_000), sample(4, 20, 9_000)]),
    ).toMatchObject({ movedPercent: 2, resets: 1 });
  });

  it("has no movement without a reading", () => {
    expect(factoryQuotaMovement([])).toBeNull();
  });
});

describe("the run's share of a plan", () => {
  const turn = (fromMinute: number, toMinute: number, spendUsd: number) => ({
    startMs: fromMinute * 60_000,
    endMs: toMinute * 60_000,
    spendUsd,
  });
  const usageOf = (
    samples: ReadonlyArray<FactoryQuotaSample>,
    turns: ReadonlyArray<ReturnType<typeof turn>>,
    machineSpendInSpanUsd: number | null,
  ) =>
    factoryRunUsageProvider({
      provider: "claude",
      windows: factoryQuotaWindows("claude", samples),
      turns,
      machineSpendUsd: 1_000,
      machineSpendInSpanUsd,
    });

  it("splits the weekly window's movement by the run's part of the spend between its readings", () => {
    const usage = usageOf(
      [sample(16, 0), sample(24, 600), { ...sample(6, 0), window: "five_hour" }],
      [turn(0, 300, 30), turn(300, 600, 27.6)],
      128,
    );

    expect(usage.windows.map((window) => window.window)).toEqual(["seven_day", "five_hour"]);
    expect(usage.runSpendUsd).toBeCloseTo(57.6, 6);
    expect(usage.machineSpendUsd).toBe(1_000);
    expect(usage.estimate).toEqual({
      window: "seven_day",
      percent: 3.6,
      runShareOfSpend: 0.45,
      runSpendUsd: expect.closeTo(57.6, 6),
      machineSpendUsd: 128,
    });
  });

  it("counts only the part of the run's spend the readings span", () => {
    // Readings at minutes 1 and 9; the turn ran from 0 to 10, then the run waited.
    const usage = usageOf([sample(10, 1), sample(11, 9)], [turn(0, 10, 10)], 8);

    expect(usage.runSpendUsd).toBe(10);
    expect(usage.estimate).toMatchObject({ runSpendUsd: 8, machineSpendUsd: 8, percent: 1 });
  });

  it("spreads a turn's spend evenly over it and counts an instant turn inside the span", () => {
    expect(factoryRunSpendBetween([turn(0, 10, 10)], 5 * 60_000, 20 * 60_000)).toBe(5);
    expect(factoryRunSpendBetween([turn(3, 3, 4)], 0, 5 * 60_000)).toBe(4);
    expect(factoryRunSpendBetween([turn(6, 6, 4)], 0, 5 * 60_000)).toBe(0);
  });

  it("never states more than the account moved", () => {
    const usage = usageOf([sample(16, 0), sample(18, 60)], [turn(0, 60, 50)], 40);
    expect(usage.estimate?.percent).toBe(2);
  });

  it("states no share without two readings apart in time or without the machine's spend", () => {
    const turns = [turn(0, 10, 10)];
    expect(usageOf([sample(16, 0)], turns, 20).estimate).toBeNull();
    expect(usageOf([sample(16, 4), sample(18, 4)], turns, 20).estimate).toBeNull();
    expect(usageOf([sample(16, 0), sample(18, 9)], turns, null).estimate).toBeNull();
    expect(usageOf([sample(16, 0), sample(18, 9)], turns, 0).estimate).toBeNull();
    expect(usageOf([sample(16, 0), sample(18, 9)], [], 20).estimate).toBeNull();
  });
});
