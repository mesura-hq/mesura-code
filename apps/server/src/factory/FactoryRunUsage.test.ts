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

const usageStub = (buckets: ReadonlyArray<UsageBucket>) =>
  ({
    readSummary: () => Effect.succeed({ buckets } as unknown as UsageSummary),
    refreshRates: Effect.die("not used"),
  }) as unknown as UsageService.UsageService["Service"];

const setUp = Effect.gen(function* () {
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
  const day = path.join(codexHome, "sessions/2026/10/24");
  yield* fs.makeDirectory(day, { recursive: true });
  yield* fs.writeFileString(
    path.join(day, `rollout-2026-10-24T07-03-00-${CODEX_SESSION}.jsonl`),
    [
      codexReading("2026-10-24T07:03:30.000Z", 12),
      codexReading("2026-10-24T07:07:30.000Z", 13),
      // A later turn of the same session is outside this one.
      codexReading("2026-10-24T09:00:00.000Z", 20),
    ].join("\n"),
  );
  const state = RUN_EVENTS.reduce(foldFactoryRunLine, emptyFactoryRunState(runDir));
  return { state, codexHome };
});

describe("factory run usage", () => {
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
