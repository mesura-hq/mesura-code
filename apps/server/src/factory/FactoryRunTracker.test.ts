// Entry points: the `attach_factory_run` MCP tool, driven through `FactoryToolkit.handle` with the
// real `FactoryRunTracker` behind it; the tracker's `stream`, which the `subscribeFactoryRun` RPC
// returns as is; `FactoryRunShellSummaries`, which the V2 projection store labels a thread's shell
// from; and `reattachFactoryRuns`, which server startup runs. The orchestrator and the card query
// are test doubles over one in-memory card store, so a card the tracker records is the card a
// restarted tracker reads. The run directory is a real temporary directory, and lines are appended
// while the tail runs. Tests wait on the tracker's own `drain` or on emitted snapshots, never on
// sleeps.
// @effect-diagnostics-next-line nodeBuiltinImport:off - hashes report fixtures synchronously to compare digests.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  FACTORY_REPORT_ACTIVITY_KIND,
  FACTORY_RUN_ACTIVITY_KIND,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as McpToolAccessTestkit from "../mcp/McpToolAccess.testkit.ts";
import * as FactoryHandlers from "../mcp/toolkits/factory/handlers.ts";
import { FactoryToolkit } from "../mcp/toolkits/factory/tools.ts";
import * as FactoryCardQuery from "../orchestration-v2/FactoryCardQuery.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as FactoryRunShellSummaries from "./FactoryRunShellSummaries.ts";
import * as FactoryRunTracker from "./FactoryRunTracker.ts";
import * as FactorySnapshotStore from "./FactorySnapshotStore.ts";

const THREAD_ID = ThreadId.make("thread-1");
const PLAIN_THREAD_ID = ThreadId.make("thread-plain");
const RUN_ID = "invoice-csv-export";
const RUN_ACTIVITY_ID = `factory-run:${THREAD_ID}:${RUN_ID}`;
const REPORT_BODY_SENTENCE = "This sentence lives only in the body of the report.";

const sha256Hex = (data: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(data).digest("hex");

/** 2026-09-28 at 09:00 plus `minute` minutes, as the recorder stamps `at`. */
const at = (minute: number) =>
  `2026-09-28T${String(9 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`;

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const eventLine = (minute: number, type: string, fields: Record<string, unknown> = {}) =>
  `${encodeJson({ v: 1, at: at(minute), type, ...fields })}\n`;

const PHASES = [
  {
    index: 1,
    title: "Serialize the filtered invoice list as CSV",
    acceptance: ["The export returns the filtered rows"],
  },
  {
    index: 2,
    title: "Add the Export button to the invoices page",
    acceptance: ["The button downloads the file"],
  },
];

const runStartedLine = (runId = RUN_ID) =>
  eventLine(0, "run.started", {
    runId,
    request: "Let accountants export the invoice list as a CSV file",
    planPath: "/srv/plans/invoice-csv-export/plan.md",
    intentPath: null,
    planDigest: `sha256:${"b".repeat(64)}`,
    routes: {
      implementer: { harness: "claude", model: "claude-opus-5-5", effort: "high", budgetUsd: 25 },
      verifier: { harness: "codex", model: "gpt-6-luna", effort: "max" },
      reviewer: { harness: "codex", model: "gpt-6-sol", effort: "high" },
    },
    returnsBudget: 5,
    phases: PHASES,
  });

/** A thread caller on the `codex` instance, the one `McpToolAccessTestkit` keeps live. */
const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId: THREAD_ID,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set<McpInvocationContext.McpCapability>(["pull-requests", "factory"]),
  issuedAt: 1,
};

type CardRecordCommand = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "factory_card.record" }
>;

/** The activity kind a card used to be recorded as, so the assertions read as before. */
const kindOfCard = (card: CardRecordCommand["card"]) =>
  card.kind === "run"
    ? FACTORY_RUN_ACTIVITY_KIND
    : card.kind === "report"
      ? FACTORY_REPORT_ACTIVITY_KIND
      : "factory.plan";

/** One Claude stream-json assistant message carrying one `tool_use` block. */
const claudeToolUseLine = (name: string, timestamp: string) =>
  `${encodeJson({
    type: "assistant",
    message: {
      type: "message",
      role: "assistant",
      content: [{ type: "tool_use", id: `toolu_${name}`, name, input: {} }],
    },
    session_id: "3f1c2a8e-5b7d-4e21-9c44-0a6f2d9b7e10",
    timestamp,
  })}\n`;

/** One Codex `--json` event for a shell command item. */
const codexItemLine = (type: "item.started" | "item.completed", id: string) =>
  `${encodeJson({
    type,
    item: {
      id,
      type: "command_execution",
      command: "/bin/bash -lc 'pnpm test'",
      aggregated_output: "",
      exit_code: type === "item.completed" ? 0 : null,
      status: type === "item.completed" ? "completed" : "in_progress",
    },
  })}\n`;

const makeHarness = Effect.fn("makeFactoryRunTrackerHarness")(function* (
  options: {
    /** Cards a previous process recorded, as the card query returns them after a restart. */
    readonly cards?: ReadonlyArray<FactoryCardQuery.FactoryCardRecord>;
  } = {},
) {
  const commands = yield* Ref.make<ReadonlyArray<CardRecordCommand>>([]);
  // The newest card per turn item id, as the projection holds them.
  const cards = yield* Ref.make<ReadonlyArray<FactoryCardQuery.FactoryCardRecord>>(
    options.cards ?? [],
  );
  // What the projection store labels the thread's shell with when the run card's event reaches it.
  const shellsSeenAtDispatch = yield* Ref.make<ReadonlyArray<unknown>>([]);
  let readShellAtDispatch: (threadId: ThreadId) => Effect.Effect<void> = () => Effect.void;

  const orchestrator = Layer.mock(Orchestrator.OrchestratorV2)({
    dispatch: (command) =>
      Effect.gen(function* () {
        if (command.type !== "factory_card.record") return yield* Effect.die("unexpected command");
        yield* Ref.update(commands, (recorded) => [...recorded, command]);
        // The card's kind and the record's kind are the same value; TypeScript cannot
        // correlate them across the union, hence the assertion.
        const record = {
          turnItemId: command.turnItemId,
          threadId: command.threadId,
          card: command.card,
          updatedAt: yield* DateTime.now,
        } as FactoryCardQuery.FactoryCardRecord;
        yield* Ref.update(cards, (stored) => [
          ...stored.filter((card) => card.turnItemId !== command.turnItemId),
          record,
        ]);
        if (command.card.kind === "run") yield* readShellAtDispatch(command.threadId);
        return { sequence: 1 } as never;
      }),
  });
  const cardQuery = Layer.mock(FactoryCardQuery.FactoryCardQuery)({
    listByKind: (kind) =>
      Ref.get(cards).pipe(
        Effect.map(
          (stored) =>
            stored.filter((record) => record.card.kind === kind) as unknown as ReadonlyArray<
              FactoryCardQuery.FactoryCardRecord<typeof kind>
            >,
        ),
      ),
    get: (turnItemId) =>
      Ref.get(cards).pipe(
        Effect.map((stored) =>
          Option.fromNullishOr(stored.find((record) => record.turnItemId === turnItemId)),
        ),
      ),
  });
  const context = yield* Layer.build(
    FactoryRunTracker.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          orchestrator,
          cardQuery,
          McpToolAccessTestkit.liveThreadsLayer,
          FactorySnapshotStore.layer,
          FactoryRunShellSummaries.layer,
        ),
      ),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-factory-run-tracker-test-" }),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

  const summaries = yield* FactoryRunShellSummaries.FactoryRunShellSummaries.pipe(
    Effect.provide(context),
  );
  readShellAtDispatch = (threadId) =>
    Ref.update(shellsSeenAtDispatch, (seen) => [...seen, summaries.get(threadId)]);

  const tracker = yield* FactoryRunTracker.FactoryRunTracker.pipe(Effect.provide(context));
  const snapshots = yield* FactorySnapshotStore.FactorySnapshotStore.pipe(Effect.provide(context));
  const toolkit = yield* FactoryToolkit.pipe(
    Effect.provide(McpToolAccess.HandlersLayer.layer(FactoryHandlers.layer)),
    Effect.provide(context),
  );
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runsDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-factory-runs-" });

  /** A run directory under a fresh temporary root; the name is its basename. */
  const makeRunDir = (name: string, lines: ReadonlyArray<string> | null) =>
    Effect.gen(function* () {
      const runDir = path.join(runsDir, name);
      yield* fileSystem.makeDirectory(runDir, { recursive: true });
      if (lines !== null) {
        yield* fileSystem.writeFileString(path.join(runDir, "events.jsonl"), lines.join(""));
      }
      return runDir;
    });

  const append = (filePath: string, text: string) =>
    fileSystem.writeFileString(filePath, text, { flag: "a" });

  const attachRun = (runDir: string) =>
    toolkit.handle("attach_factory_run", { runDir }).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => chunk.at(-1)!.result as { readonly runId: string }),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.provide(context),
    );

  /** Every card recorded in this process, oldest first, read as the activities they replaced. */
  const activities = (kind: string) =>
    Ref.get(commands).pipe(
      Effect.map((recorded) =>
        recorded.flatMap((command) =>
          kindOfCard(command.card) === kind
            ? [
                {
                  commandId: command.commandId,
                  threadId: command.threadId,
                  id: command.turnItemId as string,
                  kind,
                  payload: command.card.payload,
                },
              ]
            : [],
        ),
      ),
    );

  return {
    append,
    activities,
    cards: Ref.get(cards),
    fileSystem,
    attachRun,
    commands,
    context,
    makeRunDir,
    path,
    shellsSeenAtDispatch,
    snapshots,
    summaries,
    tracker,
  };
});

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

const lastPayload = (harness: Harness, kind: string) =>
  harness
    .activities(kind)
    .pipe(Effect.map((recorded) => recorded.at(-1)?.payload as Record<string, unknown>));

it.layer(NodeServices.layer)("factory run tracker", (it) => {
  describe("attach_factory_run", () => {
    it.effect(
      "attach_factory_run records the factory.run activity and folds the lines written before the call",
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          // sf-team names the run directory after the run: the directory's name is the run id.
          const runDir = yield* harness.makeRunDir(RUN_ID, [
            runStartedLine(),
            eventLine(1, "phase.started", { phase: 1 }),
            eventLine(1, "node.entered", { phase: 1, node: "fence" }),
          ]);

          const result = yield* harness.attachRun(runDir);

          expect(result).toEqual({ runId: RUN_ID });
          const [first] = yield* harness.activities(FACTORY_RUN_ACTIVITY_KIND);
          expect(first).toMatchObject({
            id: RUN_ACTIVITY_ID,
            threadId: THREAD_ID,
            kind: FACTORY_RUN_ACTIVITY_KIND,
            payload: {
              runId: RUN_ID,
              runDir,
              status: "running",
              phase: { index: 1, title: PHASES[0]!.title },
              node: "fence",
            },
          });
          expect(first!.commandId).toMatch(/^server:factory-run:thread-1:[0-9a-f-]{36}$/);

          // Lines appended after the call are followed too, into the same activity.
          yield* harness.append(
            harness.path.join(runDir, "events.jsonl"),
            eventLine(20, "node.entered", { phase: 1, node: "implement" }),
          );
          yield* harness.tracker.drain(THREAD_ID, RUN_ID);

          const recorded = yield* harness.activities(FACTORY_RUN_ACTIVITY_KIND);
          expect(recorded.map((activity) => activity.id)).toEqual([
            RUN_ACTIVITY_ID,
            RUN_ACTIVITY_ID,
          ]);
          expect(recorded.at(-1)!.payload).toMatchObject({ node: "implement" });
        }),
    );

    it.effect(
      "attach_factory_run refuses a relative path, a missing directory and a regular file",
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          const runDir = yield* harness.makeRunDir("refused-run", [runStartedLine()]);
          const missing = harness.path.join(runDir, "does-not-exist");
          const regularFile = harness.path.join(runDir, "events.jsonl");

          for (const [candidate, reason] of [
            ["factory-runs/refused-run", "relative-path"],
            [missing, "not-found"],
            [regularFile, "not-directory"],
          ] as const) {
            const error = yield* harness.attachRun(candidate).pipe(Effect.flip);
            expect(error).toMatchObject({ _tag: "FactoryAttachRunError", reason });
          }
          expect(yield* harness.activities(FACTORY_RUN_ACTIVITY_KIND)).toEqual([]);
        }),
    );

    it.effect(
      "attach_factory_run waits for an events file that does not exist yet and names the run after its directory",
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          const runDir = yield* harness.makeRunDir("late-run", null);

          const result = yield* harness.attachRun(runDir);

          expect(result).toEqual({ runId: "late-run" });
          // A provisional record, so a restart can follow the directory again.
          expect(yield* harness.activities(FACTORY_RUN_ACTIVITY_KIND)).toMatchObject([
            { id: `factory-run:${THREAD_ID}:late-run`, payload: { runDir, startedAt: null } },
          ]);

          yield* harness.append(
            harness.path.join(runDir, "events.jsonl"),
            runStartedLine("late-run") + eventLine(1, "phase.started", { phase: 1 }),
          );
          yield* harness.tracker.drain(THREAD_ID, "late-run");

          const latest = (yield* harness.activities(FACTORY_RUN_ACTIVITY_KIND)).at(-1);
          expect(latest).toMatchObject({
            id: `factory-run:${THREAD_ID}:late-run`,
            payload: { runId: "late-run", phase: { index: 1 } },
          });
        }),
    );
  });

  it.effect(
    "a run event replaces the factory.run activity in place only when its compact summary changes",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const runDir = yield* harness.makeRunDir(RUN_ID, [
          runStartedLine(),
          eventLine(1, "phase.started", { phase: 1 }),
          eventLine(1, "node.entered", { phase: 1, node: "fence" }),
        ]);
        const eventsPath = harness.path.join(runDir, "events.jsonl");
        yield* harness.attachRun(runDir);
        const countAfterAttach = (yield* harness.activities(FACTORY_RUN_ACTIVITY_KIND)).length;

        // A note stamped at the same time as the last event moves nothing the summary shows.
        yield* harness.append(eventsPath, eventLine(1, "note", { phase: 1, text: "Gate: none." }));
        // A line that does not decode is skipped.
        yield* harness.append(eventsPath, "{ this is not json\n");
        yield* harness.tracker.drain(THREAD_ID, RUN_ID);
        expect(yield* harness.activities(FACTORY_RUN_ACTIVITY_KIND)).toHaveLength(countAfterAttach);

        yield* harness.append(
          eventsPath,
          [
            eventLine(2, "dispatch.started", {
              phase: 1,
              role: "implementer",
              turn: 1,
              harness: "claude",
              model: "claude-opus-5-5",
              promptFile: `${runDir}/phase-1/implementer-prompt-1.md`,
              outputFile: `${runDir}/phase-1/implementer-1.jsonl`,
            }),
            eventLine(20, "dispatch.finished", {
              phase: 1,
              role: "implementer",
              turn: 1,
              sessionId: "3f1c2a8e-5b7d-4e21-9c44-0a6f2d9b7e10",
              stopReason: "end_turn",
              costUsd: 2.5,
              reportFile: `${runDir}/phase-1/implementer-1.md`,
            }),
            eventLine(30, "return.recorded", {
              phase: 1,
              kind: "repair",
              n: 1,
              budget: 5,
              node: "checks-build",
              change: "The lint failure was repaired.",
            }),
            eventLine(40, "node.entered", { phase: 1, node: "verify-1" }),
            eventLine(41, "verdict.recorded", {
              phase: 1,
              pass: 1,
              verdict: "WORKS",
              deciding: "The export returned the 14 filtered rows.",
              criteria: [{ n: 1, name: "The export returns the filtered rows", result: "PASS" }],
            }),
          ].join(""),
        );
        yield* harness.tracker.drain(THREAD_ID, RUN_ID);

        const recorded = yield* harness.activities(FACTORY_RUN_ACTIVITY_KIND);
        expect(recorded.length).toBeGreaterThan(countAfterAttach);
        expect(new Set(recorded.map((activity) => activity.id))).toEqual(
          new Set([RUN_ACTIVITY_ID]),
        );
        expect(recorded.at(-1)!.payload).toMatchObject({
          status: "running",
          phaseCount: 2,
          phase: { index: 1, title: PHASES[0]!.title },
          node: "verify-1",
          returns: { used: 1, budget: 5 },
          verdicts: [{ phase: 1, pass: 1, verdict: "WORKS" }],
          cost: { usd: 2.5 },
          lastEventAt: at(41),
        });
      }),
  );

  it.effect(
    "the thread shell carries the run's factoryRun summary when the run event reaches subscribeShell clients",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const runDir = yield* harness.makeRunDir(RUN_ID, [
          runStartedLine(),
          eventLine(1, "phase.started", { phase: 1 }),
          eventLine(1, "node.entered", { phase: 1, node: "fence" }),
        ]);
        yield* harness.attachRun(runDir);
        yield* harness.append(
          harness.path.join(runDir, "events.jsonl"),
          eventLine(5, "stop.raised", {
            phase: 1,
            node: "fence",
            question: "Name the file after the filter range or after the export date?",
            options: ["filter range", "export date"],
          }),
        );
        yield* harness.tracker.drain(THREAD_ID, RUN_ID);

        // The label a client's shell refetch reads on the run card's event already carries it.
        expect(yield* Ref.get(harness.shellsSeenAtDispatch)).toEqual([
          { status: "running", phaseIndex: 1, phaseCount: 2, node: "fence" },
          { status: "waiting", phaseIndex: 1, phaseCount: 2, node: "fence" },
        ]);

        expect(harness.summaries.get(THREAD_ID)).toEqual({
          status: "waiting",
          phaseIndex: 1,
          phaseCount: 2,
          node: "fence",
        });
        expect(harness.summaries.get(PLAIN_THREAD_ID)).toBeNull();
      }),
  );

  it.effect(
    "the factory run stream carries live role progress at most once a second and stops tailing role output with its last subscriber",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const runDir = yield* harness.makeRunDir(RUN_ID, null);
        const eventsPath = harness.path.join(runDir, "events.jsonl");
        const implementerOutput = harness.path.join(runDir, "implementer-1.jsonl");
        const verifierOutput = harness.path.join(runDir, "verifier-1.events.jsonl");
        yield* harness.append(
          implementerOutput,
          claudeToolUseLine("Read", "2026-09-28T09:03:00.000Z") +
            claudeToolUseLine("Bash", "2026-09-28T09:04:00.000Z"),
        );
        yield* harness.append(
          verifierOutput,
          codexItemLine("item.started", "item_1") + codexItemLine("item.completed", "item_1"),
        );
        yield* harness.append(
          eventsPath,
          [
            runStartedLine(),
            eventLine(1, "phase.started", { phase: 1 }),
            eventLine(2, "dispatch.started", {
              phase: 1,
              role: "implementer",
              turn: 1,
              harness: "claude",
              model: "claude-opus-5-5",
              promptFile: `${runDir}/implementer-prompt-1.md`,
              outputFile: implementerOutput,
            }),
            eventLine(10, "dispatch.finished", {
              phase: 1,
              role: "implementer",
              turn: 1,
              sessionId: "3f1c2a8e-5b7d-4e21-9c44-0a6f2d9b7e10",
              stopReason: "end_turn",
              costUsd: 1.5,
              reportFile: `${runDir}/implementer-1.md`,
            }),
            eventLine(11, "dispatch.started", {
              phase: 1,
              role: "verifier",
              turn: 1,
              harness: "codex",
              model: "gpt-6-luna",
              promptFile: `${runDir}/verifier-prompt-1.md`,
              outputFile: verifierOutput,
            }),
          ].join(""),
        );
        yield* harness.attachRun(runDir);
        // No pane is open, so no role output is read.
        expect(yield* harness.tracker.tailedFiles).toEqual([eventsPath]);

        const updates = yield* Queue.unbounded<FactoryRunTracker.FactoryRunStreamItem>();
        const subscriber = yield* harness.tracker.stream(THREAD_ID, RUN_ID).pipe(
          Stream.runForEach((item) => Queue.offer(updates, item)),
          Effect.forkChild,
        );

        const first = yield* Queue.take(updates);
        expect(first.state.runId).toBe(RUN_ID);
        expect(first.state.phases[0]!.status).toBe("running");
        expect(first.roles).toEqual([
          {
            phase: 1,
            role: "implementer",
            turn: 1,
            status: "finished",
            toolCalls: 2,
            lastTool: "Bash",
            lastActivityAt: "2026-09-28T09:04:00.000Z",
          },
          expect.objectContaining({
            phase: 1,
            role: "verifier",
            turn: 1,
            status: "running",
            toolCalls: 1,
          }),
        ]);
        expect(yield* harness.tracker.tailedFiles).toContain(verifierOutput);

        yield* harness.append(verifierOutput, codexItemLine("item.started", "item_2"));
        yield* harness.tracker.drain(THREAD_ID, RUN_ID);
        yield* TestClock.adjust(Duration.millis(999));
        expect(Option.isNone(yield* Queue.poll(updates))).toBe(true);

        yield* TestClock.adjust(Duration.millis(1));
        const second = yield* Queue.take(updates);
        expect(second.roles.find((role) => role.role === "verifier")).toMatchObject({
          status: "running",
          toolCalls: 2,
        });

        yield* Fiber.interrupt(subscriber);
        expect(yield* harness.tracker.tailedFiles).toEqual([eventsPath]);
      }),
  );

  it.effect(
    "report.written snapshots the report by digest and records a factory.report activity with its headings and no body",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const runDir = yield* harness.makeRunDir(RUN_ID, [
          runStartedLine(),
          eventLine(1, "phase.started", { phase: 1 }),
        ]);
        const reportPath = harness.path.join(runDir, "report.md");
        const report = [
          "# Report: Invoice CSV export",
          "",
          "## Context",
          "",
          REPORT_BODY_SENTENCE,
          "",
          "## What was built",
          "",
          "- The CSV export.",
          "",
          "## How it was verified",
          "",
          "By the verifier.",
          "",
        ].join("\n");
        yield* harness.append(reportPath, report);
        yield* harness.attachRun(runDir);

        yield* harness.append(
          harness.path.join(runDir, "events.jsonl"),
          eventLine(60, "report.written", { path: reportPath }),
        );
        yield* harness.tracker.drain(THREAD_ID, RUN_ID);

        const reports = yield* harness.activities(FACTORY_REPORT_ACTIVITY_KIND);
        expect(reports).toHaveLength(1);
        const digest = sha256Hex(report);
        expect(reports[0]).toMatchObject({
          id: `factory-report:${THREAD_ID}:${RUN_ID}`,
          threadId: THREAD_ID,
          payload: {
            runId: RUN_ID,
            digest,
            headings: ["Context", "What was built", "How it was verified"],
          },
        });
        expect(encodeJson(reports[0]!.payload)).not.toContain(REPORT_BODY_SENTENCE);
        const stored = yield* harness.snapshots.read(digest);
        expect(new TextDecoder().decode(stored)).toBe(report);
      }),
  );

  it.effect(
    "a malformed line, an unknown event type and record version 2 are skipped and counted while the tail keeps folding",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const runDir = yield* harness.makeRunDir(RUN_ID, [runStartedLine()]);
        yield* harness.attachRun(runDir);

        yield* harness.append(
          harness.path.join(runDir, "events.jsonl"),
          [
            "{ this is not json\n",
            eventLine(1, "run.paused", { reason: "no such type in record version 1" }),
            // Misread, this would start phase 2.
            `${encodeJson({ v: 2, at: at(2), type: "phase.started", phase: 2 })}\n`,
            eventLine(3, "phase.started", { phase: 1 }),
            eventLine(3, "node.entered", { phase: 1, node: "fence" }),
          ].join(""),
        );
        yield* harness.tracker.drain(THREAD_ID, RUN_ID);

        const current = yield* harness.tracker
          .stream(THREAD_ID, RUN_ID)
          .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
        expect(current.state.warningCount).toBe(3);
        expect(current.state.warnings).toHaveLength(3);
        expect(current.state.phases.map((phase) => phase.status)).toEqual(["running", "pending"]);
        expect(yield* lastPayload(harness, FACTORY_RUN_ACTIVITY_KIND)).toMatchObject({
          phase: { index: 1 },
          node: "fence",
        });
      }),
  );

  it.effect("the tracker stops reading a run's events.jsonl after run.finished", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const runDir = yield* harness.makeRunDir(RUN_ID, [
        runStartedLine(),
        eventLine(1, "phase.started", { phase: 1 }),
      ]);
      const eventsPath = harness.path.join(runDir, "events.jsonl");
      yield* harness.attachRun(runDir);
      expect(yield* harness.tracker.tailedFiles).toEqual([eventsPath]);

      yield* harness.append(eventsPath, eventLine(9, "run.finished", { status: "stopped" }));
      yield* harness.tracker.drain(THREAD_ID, RUN_ID);
      expect(yield* harness.tracker.tailedFiles).toEqual([]);
      expect(yield* lastPayload(harness, FACTORY_RUN_ACTIVITY_KIND)).toMatchObject({
        status: "stopped",
      });
      const countAtFinish = (yield* harness.activities(FACTORY_RUN_ACTIVITY_KIND)).length;

      // A line written after the run finished is not read.
      yield* harness.append(
        eventsPath,
        eventLine(10, "node.entered", { phase: 1, node: "commit" }),
      );
      yield* harness.tracker.drain(THREAD_ID, RUN_ID);
      expect(yield* harness.activities(FACTORY_RUN_ACTIVITY_KIND)).toHaveLength(countAtFinish);
    }),
  );

  it.effect(
    "the events watch folds run.finished by itself and the run stays readable afterwards",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const runDir = yield* harness.makeRunDir(RUN_ID, [
          runStartedLine(),
          eventLine(1, "phase.started", { phase: 1 }),
        ]);
        const eventsPath = harness.path.join(runDir, "events.jsonl");
        yield* harness.attachRun(runDir);
        const updates = yield* Queue.unbounded<FactoryRunTracker.FactoryRunStreamItem>();
        yield* harness.tracker.stream(THREAD_ID, RUN_ID).pipe(
          Stream.runForEach((item) => Queue.offer(updates, item)),
          Effect.forkChild,
        );
        expect((yield* Queue.take(updates)).state.status).toBe("running");

        // No drain: the directory watch alone carries the final line in.
        yield* harness.append(eventsPath, eventLine(9, "run.finished", { status: "stopped" }));
        let latest = yield* Queue.take(updates);
        while (latest.state.status !== "stopped") latest = yield* Queue.take(updates);

        expect(yield* harness.tracker.tailedFiles).toEqual([]);
        // The run's lock was released: a drain still completes and the state is still served.
        yield* harness.tracker.drain(THREAD_ID, RUN_ID);
        const after = yield* harness.tracker
          .stream(THREAD_ID, RUN_ID)
          .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
        expect(after.state.status).toBe("stopped");
      }).pipe(TestClock.withLive),
  );

  it.effect(
    "after a restart a re-attached run whose summary did not change dispatches no activity",
    () =>
      Effect.gen(function* () {
        const before = yield* makeHarness();
        const runDir = yield* before.makeRunDir("quiet-run", [
          runStartedLine("quiet-run"),
          eventLine(1, "phase.started", { phase: 1 }),
          eventLine(1, "node.entered", { phase: 1, node: "fence" }),
        ]);
        yield* before.attachRun(runDir);

        const after = yield* makeHarness({ cards: yield* before.cards });
        yield* ServerRuntimeStartup.reattachFactoryRuns.pipe(Effect.provide(after.context));
        yield* after.tracker.drain(THREAD_ID, "quiet-run");

        // The record already says what the run says: nothing to replace.
        expect(yield* after.activities(FACTORY_RUN_ACTIVITY_KIND)).toEqual([]);
        expect(yield* after.tracker.tailedFiles).toEqual([after.path.join(runDir, "events.jsonl")]);
      }),
  );

  describe("review rework", () => {
    /** Starts the startup reattach in a new process that holds `cards` from the last one. */
    const restartWith = (cards: ReadonlyArray<FactoryCardQuery.FactoryCardRecord>) =>
      Effect.gen(function* () {
        const after = yield* makeHarness({ cards });
        yield* ServerRuntimeStartup.reattachFactoryRuns.pipe(Effect.provide(after.context));
        return after;
      });

    it.effect("an attachment made before events.jsonl exists survives a restart", () =>
      Effect.gen(function* () {
        const before = yield* makeHarness();
        const runDir = yield* before.makeRunDir("early-run", null);
        yield* before.attachRun(runDir);
        const recorded = yield* before.activities(FACTORY_RUN_ACTIVITY_KIND);
        expect(recorded).toHaveLength(1);

        const after = yield* restartWith(yield* before.cards);
        yield* after.append(
          after.path.join(runDir, "events.jsonl"),
          runStartedLine("early-run") + eventLine(1, "phase.started", { phase: 1 }),
        );
        yield* after.tracker.drain(THREAD_ID, "early-run");

        expect((yield* after.activities(FACTORY_RUN_ACTIVITY_KIND)).at(-1)).toMatchObject({
          id: `factory-run:${THREAD_ID}:early-run`,
          payload: { runId: "early-run", startedAt: at(0), phase: { index: 1 } },
        });
      }),
    );

    it.effect("a run's id is its directory's name even when run.started names another", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const presentDir = yield* harness.makeRunDir("present-dir", [
          runStartedLine("named-otherwise"),
          eventLine(1, "phase.started", { phase: 1 }),
        ]);
        expect(yield* harness.attachRun(presentDir)).toEqual({ runId: "present-dir" });

        const lateDir = yield* harness.makeRunDir("late-dir", null);
        expect(yield* harness.attachRun(lateDir)).toEqual({ runId: "late-dir" });
        yield* harness.append(
          harness.path.join(lateDir, "events.jsonl"),
          runStartedLine("also-otherwise") + eventLine(1, "phase.started", { phase: 1 }),
        );
        yield* harness.tracker.drain(THREAD_ID, "late-dir");

        const recorded = yield* harness.activities(FACTORY_RUN_ACTIVITY_KIND);
        expect(new Set(recorded.map((activity) => activity.id))).toEqual(
          new Set([`factory-run:${THREAD_ID}:present-dir`, `factory-run:${THREAD_ID}:late-dir`]),
        );
        expect(recorded.at(-1)).toMatchObject({
          payload: { runId: "late-dir", phase: { index: 1 } },
        });
        expect(yield* harness.tracker.isAttached(THREAD_ID, "late-dir")).toBe(true);
        expect(yield* harness.tracker.isAttached(THREAD_ID, "also-otherwise")).toBe(false);
      }),
    );

    it.effect(
      "after a restart a finished run's label is restored from its record without tailing it",
      () =>
        Effect.gen(function* () {
          const before = yield* makeHarness();
          const runDir = yield* before.makeRunDir("done-run", [
            runStartedLine("done-run"),
            eventLine(1, "phase.started", { phase: 1 }),
            eventLine(2, "phase.closed", { phase: 1, close: "clean" }),
            eventLine(3, "phase.started", { phase: 2 }),
            eventLine(4, "phase.closed", { phase: 2, close: "clean" }),
            eventLine(5, "run.finished", { status: "done" }),
          ]);
          yield* before.attachRun(runDir);

          const after = yield* restartWith(yield* before.cards);

          expect(after.summaries.get(THREAD_ID)).toEqual({
            status: "done",
            phaseIndex: 2,
            phaseCount: 2,
            node: null,
          });
          expect(yield* after.tracker.tailedFiles).toEqual([]);
          expect(yield* after.activities(FACTORY_RUN_ACTIVITY_KIND)).toEqual([]);
        }),
    );

    // Archived threads' cards are in the card query's answer (FactoryCardQuery.test.ts covers
    // the SQL); the tracker follows every unfinished run that answer holds.
    it.effect("after a restart every unfinished run the card query returns is followed again", () =>
      Effect.gen(function* () {
        const before = yield* makeHarness();
        const runDir = yield* before.makeRunDir("shelved-run", [
          runStartedLine("shelved-run"),
          eventLine(1, "phase.started", { phase: 1 }),
        ]);
        yield* before.attachRun(runDir);

        const after = yield* restartWith(yield* before.cards);
        expect(yield* after.tracker.isAttached(THREAD_ID, "shelved-run")).toBe(true);
      }),
    );

    it.effect("a pane opened again reads a role's output from where the last one stopped", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const runDir = yield* harness.makeRunDir(RUN_ID, null);
        const output = harness.path.join(runDir, "implementer-1.jsonl");
        const toolLine = claudeToolUseLine("Grep", "2026-09-28T09:04:00.000Z");
        // A line without a tool call, exactly as long as `toolLine`.
        const quietBase = encodeJson({
          type: "assistant",
          message: { type: "message", role: "assistant", content: [] },
          pad: "",
        });
        const quietLine = `${encodeJson({
          type: "assistant",
          message: { type: "message", role: "assistant", content: [] },
          pad: "x".repeat(toolLine.length - 1 - quietBase.length),
        })}\n`;
        expect(quietLine.length).toBe(toolLine.length);
        const firstLine = claudeToolUseLine("Read", "2026-09-28T09:03:00.000Z");
        yield* harness.append(output, firstLine + quietLine);
        yield* harness.append(
          harness.path.join(runDir, "events.jsonl"),
          runStartedLine() +
            eventLine(1, "phase.started", { phase: 1 }) +
            eventLine(2, "dispatch.started", {
              phase: 1,
              role: "implementer",
              turn: 1,
              harness: "claude",
              model: "claude-opus-5-5",
              promptFile: `${runDir}/implementer-prompt-1.md`,
              outputFile: output,
            }),
        );
        yield* harness.attachRun(runDir);
        const toolCallsOfFirstItem = harness.tracker.stream(THREAD_ID, RUN_ID).pipe(
          Stream.runHead,
          Effect.map((item) => Option.getOrThrow(item).roles[0]!.toolCalls),
        );
        expect(yield* toolCallsOfFirstItem).toBe(1);

        // Rewrite what was already read, in place and at the same length, then append.
        // Read again from its offset, only the appended line counts; read from byte
        // zero, the rewritten line would count too.
        yield* harness.fileSystem.writeFileString(output, firstLine + toolLine);
        yield* harness.append(output, claudeToolUseLine("Bash", "2026-09-28T09:05:00.000Z"));
        expect(yield* toolCallsOfFirstItem).toBe(2);
      }),
    );

    it.effect("a role's output replaced while no pane is open is read again from its start", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const runDir = yield* harness.makeRunDir(RUN_ID, null);
        const output = harness.path.join(runDir, "implementer-1.jsonl");
        const readLine = claudeToolUseLine("Read", "2026-09-28T09:03:00.000Z");
        const grepLine = claudeToolUseLine("Grep", "2026-09-28T09:04:00.000Z");
        yield* harness.append(output, readLine);
        yield* harness.append(
          harness.path.join(runDir, "events.jsonl"),
          runStartedLine() +
            eventLine(1, "phase.started", { phase: 1 }) +
            eventLine(2, "dispatch.started", {
              phase: 1,
              role: "implementer",
              turn: 1,
              harness: "claude",
              model: "claude-opus-5-5",
              promptFile: `${runDir}/implementer-prompt-1.md`,
              outputFile: output,
            }),
        );
        yield* harness.attachRun(runDir);
        const roleOfFirstItem = harness.tracker.stream(THREAD_ID, RUN_ID).pipe(
          Stream.runHead,
          Effect.map((item) => Option.getOrThrow(item).roles[0]!),
        );
        expect(yield* roleOfFirstItem).toMatchObject({ toolCalls: 1, lastTool: "Read" });

        // With the pane closed, another file of the same length takes the path:
        // ext4 may give it the deleted file's inode number unless the role's
        // tail still holds that file. Read from the old offset, nothing is new
        // and the pane would still show `Read`.
        yield* harness.fileSystem.remove(output);
        yield* harness.append(output, grepLine);
        expect(grepLine.length).toBe(readLine.length);
        expect(yield* roleOfFirstItem).toMatchObject({ toolCalls: 1, lastTool: "Grep" });
      }),
    );

    it.effect(
      "a finished run with no subscriber is dropped from memory and rebuilt from its record for the next pane",
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          const runDir = yield* harness.makeRunDir(RUN_ID, [
            runStartedLine(),
            eventLine(1, "phase.started", { phase: 1 }),
          ]);
          yield* harness.attachRun(runDir);
          const pane = yield* harness.tracker
            .stream(THREAD_ID, RUN_ID)
            .pipe(Stream.runDrain, Effect.forkChild);
          yield* harness.append(
            harness.path.join(runDir, "events.jsonl"),
            eventLine(9, "run.finished", { status: "stopped" }),
          );
          yield* harness.tracker.drain(THREAD_ID, RUN_ID);
          yield* Fiber.interrupt(pane);

          expect(yield* harness.tracker.isAttached(THREAD_ID, RUN_ID)).toBe(false);
          expect(yield* harness.tracker.tailedFiles).toEqual([]);

          const recorded = yield* harness.activities(FACTORY_RUN_ACTIVITY_KIND);
          const item = yield* FactoryRunTracker.subscribeFactoryRun(harness.tracker, {
            threadId: THREAD_ID,
            runId: RUN_ID,
          }).pipe(Stream.runHead, Effect.map(Option.getOrThrow));
          expect(item.state.status).toBe("stopped");
          // Rebuilding reads the record; it records nothing new.
          expect(yield* harness.activities(FACTORY_RUN_ACTIVITY_KIND)).toHaveLength(
            recorded.length,
          );
        }),
    );
  });

  it.effect(
    "after a restart every run card whose run is not finished is attached again from its run directory",
    () =>
      Effect.gen(function* () {
        const before = yield* makeHarness();
        const liveDir = yield* before.makeRunDir("live-run", [
          runStartedLine("live-run"),
          eventLine(1, "phase.started", { phase: 1 }),
          eventLine(1, "node.entered", { phase: 1, node: "fence" }),
        ]);
        const doneDir = yield* before.makeRunDir("done-run", [
          runStartedLine("done-run"),
          eventLine(1, "phase.started", { phase: 1 }),
          eventLine(2, "phase.closed", { phase: 1, close: "clean" }),
          eventLine(3, "phase.started", { phase: 2 }),
          eventLine(4, "phase.closed", { phase: 2, close: "clean" }),
          eventLine(5, "run.finished", { status: "done" }),
        ]);
        yield* before.attachRun(liveDir);
        yield* before.attachRun(doneDir);
        // What the projection holds: the newest card per id.
        const cards = yield* before.cards;
        expect(cards.map((card) => card.turnItemId as string).toSorted()).toEqual([
          `factory-run:${THREAD_ID}:done-run`,
          `factory-run:${THREAD_ID}:live-run`,
        ]);

        // A new process: a fresh tracker that follows nothing yet.
        const after = yield* makeHarness({ cards });
        yield* ServerRuntimeStartup.reattachFactoryRuns.pipe(Effect.provide(after.context));

        expect(yield* after.tracker.isAttached(THREAD_ID, "live-run")).toBe(true);
        expect(yield* after.tracker.isAttached(THREAD_ID, "done-run")).toBe(false);
        expect(yield* after.tracker.tailedFiles).toEqual([
          after.path.join(liveDir, "events.jsonl"),
        ]);
        yield* after.append(
          after.path.join(liveDir, "events.jsonl"),
          eventLine(20, "node.entered", { phase: 1, node: "implement" }),
        );
        yield* after.tracker.drain(THREAD_ID, "live-run");
        const resumed = yield* after.activities(FACTORY_RUN_ACTIVITY_KIND);
        expect(resumed.at(-1)).toMatchObject({
          id: `factory-run:${THREAD_ID}:live-run`,
          payload: { runId: "live-run", node: "implement" },
        });
      }),
  );
});
