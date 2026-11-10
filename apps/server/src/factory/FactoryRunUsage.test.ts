// Entry point: `readFactoryRunUsageOf`, the body of the `factory.readRunUsage` handler, over a
// run directory and a Codex home on disk and a stub of the machine's usage summary.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { UsageBucket, UsageSummary } from "@t3tools/contracts";
import { emptyFactoryRunState, foldFactoryRunLine } from "@t3tools/shared/factoryRun";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type * as UsageService from "../usage/UsageService.ts";
import { readFactoryRunUsageOf } from "./FactoryRunUsage.ts";

const CLAUDE_SESSION = "df1c8b08-4ee2-4ecd-a9c3-5ab78b5c273f";
const CODEX_SESSION = "01a16cb8-94e4-7583-a7a4-72fa8c7016f3";

const claudeReading = (fiveHour: number, sevenDay: number) =>
  JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: {
      unifiedWindows: {
        five_hour: { utilization: fiveHour, resetsAt: 1792829400 },
        seven_day: { utilization: sevenDay, resetsAt: 1793019600 },
      },
    },
  });

const codexReading = (timestamp: string, usedPercent: number) =>
  JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        primary: { used_percent: usedPercent, window_minutes: 10080, resets_at: 1793382080 },
        secondary: null,
      },
    },
  });

const line = (event: Record<string, unknown>) => JSON.stringify({ v: 1, ...event });

const RUN_EVENTS = [
  line({
    at: "2026-10-24T06:43:00.000Z",
    type: "run.started",
    runId: "usage-run",
    request: "Usage",
    phases: [{ index: 1, title: "One", acceptance: [] }],
  }),
  line({
    at: "2026-10-24T06:44:00.000Z",
    type: "dispatch.started",
    phase: 1,
    role: "implementer",
    turn: 1,
    harness: "claude",
    model: "claude-opus-5-5",
    promptFile: "phase-1/implementer-prompt-1.md",
    outputFile: "phase-1/implementer-1.jsonl",
  }),
  line({
    at: "2026-10-24T06:52:00.000Z",
    type: "dispatch.finished",
    phase: 1,
    role: "implementer",
    turn: 1,
    sessionId: CLAUDE_SESSION,
    stopReason: "end_turn",
    costUsd: 20,
    reportFile: "phase-1/implementer-1.md",
  }),
  line({
    at: "2026-10-24T07:03:00.000Z",
    type: "dispatch.started",
    phase: 1,
    role: "verifier",
    turn: 1,
    harness: "codex",
    model: "gpt-6-luna",
    promptFile: "phase-1/verifier-prompt-1.md",
    outputFile: "phase-1/verifier-1.events.jsonl",
  }),
  line({
    at: "2026-10-24T07:08:00.000Z",
    type: "dispatch.finished",
    phase: 1,
    role: "verifier",
    turn: 1,
    sessionId: CODEX_SESSION,
    stopReason: "completed",
    tokens: { input_tokens: 2_000_000, cached_input_tokens: 1_800_000, output_tokens: 30_000 },
    reportFile: "phase-1/verifier-1.md",
  }),
  line({ at: "2026-10-24T07:10:00.000Z", type: "run.finished", status: "done" }),
];

const bucket = (provider: "claude" | "codex", model: string, costUsd: number): UsageBucket =>
  ({
    day: "2026-10-24",
    provider,
    model,
    totals: {
      uncachedInputTokens: 1_000_000,
      cachedInputTokens: 10_000_000,
      cacheCreationTokens: 0,
      outputTokens: 100_000,
      reasoningTokens: 0,
    },
    costUsd,
    cacheSavingsUsd: 0,
    // $1 per million uncached input, $0.1 per million cached, $10 per million output.
    categoryCostUsd: { input: 1, cacheRead: 1, cacheWrite: 0, output: 1 },
    costSource: "modelPriced",
    records: 1,
    unpricedRecords: 0,
    sessions: 1,
  }) as UsageBucket;

type SummaryInput = Parameters<UsageService.UsageService["Service"]["readSummary"]>[0];

const usageStub = (
  buckets: ReadonlyArray<UsageBucket> | ((input: SummaryInput) => ReadonlyArray<UsageBucket>),
) =>
  ({
    readSummary: (input: SummaryInput) =>
      Effect.succeed({
        buckets: typeof buckets === "function" ? buckets(input) : buckets,
      } as unknown as UsageSummary),
    refreshRates: Effect.die("not used"),
  }) as unknown as UsageService.UsageService["Service"];

/** The day directory the Codex session's rollout is filed under: the day the session began. */
const setUpWith = (codexDay: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-run-usage-" });
    const runDir = path.join(root, "usage-run");
    yield* fs.makeDirectory(path.join(runDir, "phase-1"), { recursive: true });
    yield* fs.writeFileString(
      path.join(runDir, "phase-1/implementer-1.jsonl"),
      [claudeReading(0.06, 0.16), '{"type":"assistant"}', claudeReading(0.09, 0.18)].join("\n"),
    );
    const codexHome = path.join(root, "codex");
    const day = path.join(codexHome, "sessions", ...codexDay.split("-"));
    yield* fs.makeDirectory(day, { recursive: true });
    // Another session's rollout on a later day, which the search must pass over.
    const later = path.join(codexHome, "sessions/2026/10/25");
    yield* fs.makeDirectory(later, { recursive: true });
    yield* fs.writeFileString(path.join(later, "rollout-2026-10-25T01-00-00-other.jsonl"), "");
    yield* fs.writeFileString(
      path.join(day, `rollout-${codexDay}T07-03-00-${CODEX_SESSION}.jsonl`),
      [
        // An earlier turn of the same session, before the run.
        codexReading(`${codexDay}T07:00:00.000Z`, 5),
        codexReading("2026-10-24T07:03:30.000Z", 12),
        codexReading("2026-10-24T07:07:30.000Z", 13),
        // A later turn of the same session is outside this one.
        codexReading("2026-10-24T09:00:00.000Z", 20),
      ].join("\n"),
    );
    const state = RUN_EVENTS.reduce(foldFactoryRunLine, emptyFactoryRunState(runDir));
    return { state, codexHome };
  });

const setUp = setUpWith("2026-10-24");

describe("factory run usage", () => {
  it.effect(
    "counts the machine's spend after the first reading and with the last, as the movement does",
    () =>
      Effect.gen(function* () {
        const { state, codexHome } = yield* setUp;
        // The usage summary counts records in [sinceTime, untilTime), as UsageAggregator does.
        const spends = [
          { atMs: Date.parse("2026-10-24T07:03:30.000Z"), usd: 100 },
          { atMs: Date.parse("2026-10-24T07:05:00.000Z"), usd: 5 },
          { atMs: Date.parse("2026-10-24T07:07:30.000Z"), usd: 4 },
        ];
        const usage = yield* readFactoryRunUsageOf(
          state,
          Option.some(
            usageStub((input) => {
              const sinceMs = Date.parse(input.sinceTime!);
              const untilMs = Date.parse(input.untilTime!);
              const usd = spends
                .filter((spend) => spend.atMs >= sinceMs && spend.atMs < untilMs)
                .reduce((sum, spend) => sum + spend.usd, 0);
              return usd === 0 ? [] : [bucket("codex", "gpt-6-luna", usd)];
            }),
          ),
          codexHome,
        );

        const codex = usage.providers.find((provider) => provider.provider === "codex")!;
        // 07:03:30 is the first reading itself, before the movement; 07:07:30 is the last.
        expect(codex.windows).toMatchObject([{ firstAt: "2026-10-24T07:03:30.000Z" }]);
        expect(codex.estimate?.machineSpendUsd).toBe(9);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reads the account's movement from the role outputs and splits it by this machine's spend",
    () =>
      Effect.gen(function* () {
        const { state, codexHome } = yield* setUp;
        const usage = yield* readFactoryRunUsageOf(
          state,
          Option.some(
            usageStub([bucket("claude", "claude-opus-5-5", 80), bucket("codex", "gpt-6-luna", 9)]),
          ),
          codexHome,
        );

        expect(usage.machineSpend).toBe("read");
        const claude = usage.providers.find((provider) => provider.provider === "claude")!;
        expect(
          claude.windows.map(({ window, movedPercent }) => ({ window, movedPercent })),
        ).toEqual([
          { window: "five_hour", movedPercent: 3 },
          { window: "seven_day", movedPercent: 2 },
        ]);
        expect(claude.runSpendUsd).toBe(20);
        expect(claude.machineSpendUsd).toBe(80);
        expect(claude.estimate).toEqual({
          window: "seven_day",
          percent: 0.5,
          runShareOfSpend: 0.25,
          runSpendUsd: 20,
          machineSpendUsd: 80,
        });

        const codex = usage.providers.find((provider) => provider.provider === "codex")!;
        expect(codex.windows).toMatchObject([
          { window: "seven_day", firstPercent: 12, lastPercent: 13, movedPercent: 1, samples: 2 },
        ]);
        // 200k uncached at $1/M, 1.8M cached at $0.1/M, 30k output at $10/M.
        expect(codex.runSpendUsd).toBeCloseTo(0.2 + 0.18 + 0.3, 6);
        expect(codex.machineSpendUsd).toBe(9);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("compares the run's spend with the machine's over the span the readings cover", () =>
    Effect.gen(function* () {
      const { state, codexHome } = yield* setUp;
      const queried: Array<string> = [];
      const usage = yield* readFactoryRunUsageOf(
        state,
        Option.some(
          usageStub((input) => {
            queried.push(`${input.sinceTime} ${input.untilTime}`);
            // The whole run includes $960 spent after the last reading.
            const whole = input.sinceTime === "2026-10-24T06:43:00.000Z";
            return [bucket("claude", "claude-opus-5-5", whole ? 1_000 : 40)];
          }),
        ),
        codexHome,
      );

      const claude = usage.providers.find((provider) => provider.provider === "claude")!;
      expect(queried).toContain("2026-10-24T06:44:00.001Z 2026-10-24T06:52:00.001Z");
      expect(claude.machineSpendUsd).toBe(1_000);
      expect(claude.estimate).toMatchObject({ runSpendUsd: 20, machineSpendUsd: 40, percent: 1 });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads the readings of a resumed session's rollout past 64 MiB", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { state, codexHome } = yield* setUp;
      const rollout = path.join(
        codexHome,
        "sessions/2026/10/24",
        `rollout-2026-10-24T07-03-00-${CODEX_SESSION}.jsonl`,
      );
      // Earlier turns of a long-lived session fill the file before this run's readings.
      const filler = `${JSON.stringify({ type: "response_item", payload: "x".repeat(1_000) })}\n`;
      const original = yield* fs.readFileString(rollout);
      yield* fs.writeFileString(rollout, filler.repeat(70_000) + original);

      const usage = yield* readFactoryRunUsageOf(state, Option.none(), codexHome);
      const codex = usage.providers.find((provider) => provider.provider === "codex")!;
      expect(codex.windows).toMatchObject([
        { window: "seven_day", firstPercent: 12, lastPercent: 13, movedPercent: 1 },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads a resumed Codex session from the day the session began", () =>
    Effect.gen(function* () {
      const { state, codexHome } = yield* setUpWith("2026-10-20");
      const usage = yield* readFactoryRunUsageOf(state, Option.none(), codexHome);

      const codex = usage.providers.find((provider) => provider.provider === "codex")!;
      expect(codex.windows).toMatchObject([
        { window: "seven_day", firstPercent: 12, lastPercent: 13, movedPercent: 1, samples: 2 },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("still answers the movement when the machine's usage cannot be read", () =>
    Effect.gen(function* () {
      const { state, codexHome } = yield* setUp;
      const usage = yield* readFactoryRunUsageOf(state, Option.none(), codexHome);

      expect(usage.machineSpend).toBe("unavailable");
      expect(usage.providers.map((provider) => provider.estimate)).toEqual([null, null]);
      expect(usage.providers[0]!.windows.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
