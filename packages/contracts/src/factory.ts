import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * Thread activities the Software Factory writes. Each is small and replaced in
 * place by id; document bodies never travel in them, only digests a client
 * reads back through `factoryReadSnapshot`.
 */
export const FACTORY_PLAN_ACTIVITY_KIND = "factory.plan";
export const FACTORY_RUN_ACTIVITY_KIND = "factory.run";
export const FACTORY_REPORT_ACTIVITY_KIND = "factory.report";
export const FACTORY_ACTIVITY_KINDS: ReadonlyArray<string> = [
  FACTORY_PLAN_ACTIVITY_KIND,
  FACTORY_RUN_ACTIVITY_KIND,
  FACTORY_REPORT_ACTIVITY_KIND,
];

/**
 * How many of a thread's newest Factory activities the server keeps past its
 * 500-activity window. A build buries its plan under about a thousand tool
 * calls, and each activity is replaced in place by id, so a few ids per plan
 * file and run cover a thread; the bound keeps a pathological thread finite.
 */
export const FACTORY_ACTIVITY_RETENTION_LIMIT = 16;

/** The sha256 of a stored document, as 64 lowercase hex characters. */
export const FACTORY_SNAPSHOT_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
export const FactorySnapshotDigest = Schema.String.check(
  Schema.isPattern(FACTORY_SNAPSHOT_DIGEST_PATTERN),
);
export type FactorySnapshotDigest = typeof FactorySnapshotDigest.Type;

export const isFactorySnapshotDigest = (value: string): value is FactorySnapshotDigest =>
  FACTORY_SNAPSHOT_DIGEST_PATTERN.test(value);

export const FactoryPlanActivityPhase = Schema.Struct({
  title: TrimmedNonEmptyString,
  acceptanceCount: NonNegativeInt,
});
export type FactoryPlanActivityPhase = typeof FactoryPlanActivityPhase.Type;

/** Payload of a `factory.plan` activity: enough to render a card, never the body. */
export const FactoryPlanActivityPayload = Schema.Struct({
  digest: FactorySnapshotDigest,
  intentDigest: FactorySnapshotDigest,
  planPath: TrimmedNonEmptyString,
  intentPath: TrimmedNonEmptyString,
  title: Schema.String,
  phases: Schema.Array(FactoryPlanActivityPhase),
  /** Every level-two heading of the plan, in document order. */
  headings: Schema.Array(Schema.String),
  presentedAt: IsoDateTime,
});
export type FactoryPlanActivityPayload = typeof FactoryPlanActivityPayload.Type;

export const FactoryReadSnapshotInput = Schema.Struct({
  /**
   * Any string on the wire: the server checks the digest's shape and answers a
   * malformed one with `FactoryReadSnapshotError` (`invalid-digest`). A
   * pattern here would fail in decoding instead, outside the declared error.
   */
  digest: Schema.String,
});
export type FactoryReadSnapshotInput = typeof FactoryReadSnapshotInput.Type;

/** A digest names fixed bytes, so a client may cache this answer forever. */
export const FactoryReadSnapshotResult = Schema.Struct({
  digest: FactorySnapshotDigest,
  markdown: Schema.String,
});
export type FactoryReadSnapshotResult = typeof FactoryReadSnapshotResult.Type;

const FACTORY_READ_SNAPSHOT_ERROR_MESSAGES = {
  "invalid-digest": "A snapshot digest is 64 lowercase hex characters.",
  "not-found": "No snapshot is stored under that digest.",
  "read-failed": "The snapshot could not be read.",
} as const;

export class FactoryReadSnapshotError extends Schema.TaggedError<FactoryReadSnapshotError>()(
  "FactoryReadSnapshotError",
  {
    reason: Schema.Literals(["invalid-digest", "not-found", "read-failed"]),
    digest: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return FACTORY_READ_SNAPSHOT_ERROR_MESSAGES[this.reason];
  }
}

// ---------------------------------------------------------------------------
// Software Factory runs.
//
// A run directory holds `events.jsonl`, one record-version-1 event per line.
// The single definition of that record is
// `skills/core/sf-team/bin/run-events.mjs` in the agent-env repository; the
// schemas below decode the same shape, and `@t3tools/shared/factoryRun` folds
// it into `FactoryRunState`.
// ---------------------------------------------------------------------------

export const FACTORY_RUN_RECORD_VERSION = 1;

export const factoryRunActivityId = (threadId: string, runId: string) =>
  `factory-run:${threadId}:${runId}`;
export const factoryReportActivityId = (threadId: string, runId: string) =>
  `factory-report:${threadId}:${runId}`;

export const FactoryRunRole = Schema.Literals(["implementer", "verifier", "reviewer"]);
export type FactoryRunRole = typeof FactoryRunRole.Type;
export const FactoryRunHarness = Schema.Literals(["claude", "codex", "opencode"]);
export const FactoryRunVerdict = Schema.Literals([
  "WORKS",
  "BROKEN",
  "COULD_NOT_EXERCISE",
  "NOT_NEEDED",
]);
export type FactoryRunVerdict = typeof FactoryRunVerdict.Type;
export const FactoryRunDisposition = Schema.Literals(["repaired", "rejected", "deferred"]);

const PhaseNumber = PositiveInt;
const TokenCounts = Schema.Record(Schema.String, Schema.Number);

const FactoryRunRoute = Schema.Struct({
  harness: FactoryRunHarness,
  model: Schema.String,
  effort: Schema.String,
  budgetUsd: Schema.optional(Schema.Number),
});

const FactoryRunPhaseCommit = Schema.Union([
  Schema.Struct({ hash: Schema.String, subject: Schema.String }),
  Schema.Struct({ blocked: Schema.String }),
]);

const FactoryRunCriterionResult = Schema.Struct({
  n: PhaseNumber,
  name: Schema.String,
  result: Schema.Literals(["PASS", "FAIL", "NOT_EXERCISED"]),
  authoredTestsOnly: Schema.optional(Schema.Boolean),
});

const eventOf = <Type extends string, Fields extends Schema.Struct.Fields>(
  type: Type,
  fields: Fields,
) =>
  Schema.Struct({ v: Schema.Literal(1), at: IsoDateTime, type: Schema.Literal(type), ...fields });

/** Every record-version-1 event type, keyed by `type`. */
export const FactoryRunEventSchemas = {
  "run.started": eventOf("run.started", {
    runId: Schema.String,
    request: Schema.String,
    planPath: Schema.String,
    intentPath: Schema.NullOr(Schema.String),
    planDigest: Schema.String,
    routes: Schema.Struct({
      implementer: FactoryRunRoute,
      verifier: FactoryRunRoute,
      reviewer: FactoryRunRoute,
    }),
    returnsBudget: NonNegativeInt,
    phases: Schema.Array(
      Schema.Struct({
        index: PhaseNumber,
        title: Schema.String,
        acceptance: Schema.Array(Schema.String),
      }),
    ),
  }),
  "frame.recorded": eventOf("frame.recorded", {
    repo: Schema.String,
    branch: Schema.String,
    base: Schema.String,
    testLayout: Schema.String,
    checks: Schema.Array(Schema.String),
    suiteAtFrame: Schema.String,
  }),
  "phase.started": eventOf("phase.started", { phase: PhaseNumber }),
  "node.entered": eventOf("node.entered", { phase: PhaseNumber, node: Schema.String }),
  "dispatch.started": eventOf("dispatch.started", {
    phase: PhaseNumber,
    role: FactoryRunRole,
    turn: PhaseNumber,
    harness: FactoryRunHarness,
    model: Schema.String,
    promptFile: Schema.String,
    outputFile: Schema.String,
    sessionId: Schema.optional(Schema.String),
  }),
  "dispatch.finished": eventOf("dispatch.finished", {
    phase: PhaseNumber,
    role: FactoryRunRole,
    turn: PhaseNumber,
    sessionId: Schema.String,
    stopReason: Schema.String,
    costUsd: Schema.optional(Schema.Number),
    tokens: Schema.optional(TokenCounts),
    reportFile: Schema.String,
  }),
  "checks.recorded": eventOf("checks.recorded", {
    phase: PhaseNumber,
    stage: Schema.Literals(["build", "harden"]),
    results: Schema.Array(Schema.Struct({ command: Schema.String, exit: Schema.Int })),
  }),
  "verdict.recorded": eventOf("verdict.recorded", {
    phase: PhaseNumber,
    pass: Schema.Literals([1, 2]),
    verdict: FactoryRunVerdict,
    deciding: Schema.String,
    criteria: Schema.Array(FactoryRunCriterionResult),
  }),
  "findings.recorded": eventOf("findings.recorded", {
    phase: PhaseNumber,
    findings: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        severity: Schema.Literals(["P0", "P1", "P2", "P3"]),
        title: Schema.String,
      }),
    ),
  }),
  "disposition.recorded": eventOf("disposition.recorded", {
    phase: PhaseNumber,
    id: Schema.String,
    disposition: FactoryRunDisposition,
    reason: Schema.String,
  }),
  "return.recorded": eventOf("return.recorded", {
    phase: PhaseNumber,
    kind: Schema.Literals(["repair", "rework"]),
    n: PhaseNumber,
    budget: PhaseNumber,
    node: Schema.String,
    change: Schema.String,
  }),
  "deviation.recorded": eventOf("deviation.recorded", {
    phase: PhaseNumber,
    path: Schema.String,
    kind: Schema.Literals(["widened", "carried", "skipped"]),
    reason: Schema.String,
  }),
  "stop.raised": eventOf("stop.raised", {
    phase: Schema.optional(PhaseNumber),
    node: Schema.optional(Schema.String),
    question: Schema.String,
    options: Schema.Array(Schema.String),
  }),
  "stop.answered": eventOf("stop.answered", { answer: Schema.String }),
  note: eventOf("note", { phase: Schema.optional(PhaseNumber), text: Schema.String }),
  "phase.closed": eventOf("phase.closed", {
    phase: PhaseNumber,
    close: Schema.Union([
      Schema.Literal("clean"),
      Schema.Struct({ degraded: Schema.Array(Schema.String) }),
    ]),
    commit: Schema.optional(FactoryRunPhaseCommit),
  }),
  "report.written": eventOf("report.written", { path: Schema.String }),
  "run.finished": eventOf("run.finished", { status: Schema.Literals(["done", "stopped"]) }),
} as const;

export type FactoryRunEventType = keyof typeof FactoryRunEventSchemas;

/**
 * One decoded record-version-1 event. Decoding is tolerant at the line level:
 * a line of another version or an unknown type is reported and skipped by the
 * fold, never an error that stops the tail.
 */
export const FactoryRunEvent = Schema.Union(Object.values(FactoryRunEventSchemas));
export type FactoryRunEvent = typeof FactoryRunEvent.Type;

/** `done` and `degraded` are finished runs; `degraded` closed at least one phase degraded. */
export const FactoryRunStatus = Schema.Literals([
  "running",
  "waiting",
  "done",
  "degraded",
  "stopped",
]);
export type FactoryRunStatus = typeof FactoryRunStatus.Type;

export const isFactoryRunFinished = (status: FactoryRunStatus) =>
  status === "done" || status === "degraded" || status === "stopped";

export const FactoryRunCost = Schema.Struct({
  usd: Schema.Number,
  /** The per-key sum of Codex `usage` objects, under Codex's own key names. */
  tokens: TokenCounts,
});
export type FactoryRunCost = typeof FactoryRunCost.Type;

export const FactoryRunClock = Schema.Struct({
  elapsedMs: NonNegativeInt,
  /** The sum of `stop.raised` to `stop.answered` intervals. */
  waitingMs: NonNegativeInt,
  machineMs: NonNegativeInt,
});
export type FactoryRunClock = typeof FactoryRunClock.Type;

export const FactoryRunDispatch = Schema.Struct({
  role: FactoryRunRole,
  turn: PhaseNumber,
  harness: FactoryRunHarness,
  model: Schema.String,
  promptFile: Schema.String,
  outputFile: Schema.String,
  sessionId: Schema.NullOr(Schema.String),
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  stopReason: Schema.NullOr(Schema.String),
  costUsd: Schema.NullOr(Schema.Number),
  tokens: Schema.NullOr(TokenCounts),
  reportFile: Schema.NullOr(Schema.String),
});
export type FactoryRunDispatch = typeof FactoryRunDispatch.Type;

export const FactoryRunPhaseStatus = Schema.Literals(["pending", "running", "clean", "degraded"]);
export type FactoryRunPhaseStatus = typeof FactoryRunPhaseStatus.Type;

export const FactoryRunPhase = Schema.Struct({
  index: PhaseNumber,
  title: Schema.String,
  acceptance: Schema.Array(Schema.String),
  status: FactoryRunPhaseStatus,
  node: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(IsoDateTime),
  closedAt: Schema.NullOr(IsoDateTime),
  dispatches: Schema.Array(FactoryRunDispatch),
  checks: Schema.Array(
    Schema.Struct({
      stage: Schema.Literals(["build", "harden"]),
      at: IsoDateTime,
      results: Schema.Array(Schema.Struct({ command: Schema.String, exit: Schema.Int })),
    }),
  ),
  verdicts: Schema.Array(
    Schema.Struct({
      pass: Schema.Literals([1, 2]),
      verdict: FactoryRunVerdict,
      deciding: Schema.String,
      at: IsoDateTime,
      criteria: Schema.Array(FactoryRunCriterionResult),
    }),
  ),
  findings: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      severity: Schema.Literals(["P0", "P1", "P2", "P3"]),
      title: Schema.String,
      disposition: Schema.NullOr(FactoryRunDisposition),
      reason: Schema.NullOr(Schema.String),
    }),
  ),
  deviations: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      kind: Schema.Literals(["widened", "carried", "skipped"]),
      reason: Schema.String,
    }),
  ),
  degraded: Schema.Array(Schema.String),
  commit: Schema.NullOr(FactoryRunPhaseCommit),
});
export type FactoryRunPhase = typeof FactoryRunPhase.Type;

export const FactoryRunReturn = Schema.Struct({
  phase: PhaseNumber,
  kind: Schema.Literals(["repair", "rework"]),
  n: PhaseNumber,
  budget: PhaseNumber,
  node: Schema.String,
  change: Schema.String,
  at: IsoDateTime,
});
export type FactoryRunReturn = typeof FactoryRunReturn.Type;

export const FactoryRunStop = Schema.Struct({
  phase: Schema.NullOr(PhaseNumber),
  node: Schema.NullOr(Schema.String),
  question: Schema.String,
  options: Schema.Array(Schema.String),
  raisedAt: IsoDateTime,
  answeredAt: Schema.NullOr(IsoDateTime),
  answer: Schema.NullOr(Schema.String),
});
export type FactoryRunStop = typeof FactoryRunStop.Type;

/** A line the fold skipped: 1-based line number and why. */
export const FactoryRunWarning = Schema.Struct({ line: PositiveInt, problem: Schema.String });
export type FactoryRunWarning = typeof FactoryRunWarning.Type;

/** The full fold of a run's events. It travels only to an open Factory pane, never in an activity. */
export const FactoryRunState = Schema.Struct({
  runId: Schema.String,
  runDir: Schema.String,
  request: Schema.NullOr(Schema.String),
  planPath: Schema.NullOr(Schema.String),
  intentPath: Schema.NullOr(Schema.String),
  planDigest: Schema.NullOr(Schema.String),
  routes: Schema.NullOr(
    Schema.Struct({
      implementer: FactoryRunRoute,
      verifier: FactoryRunRoute,
      reviewer: FactoryRunRoute,
    }),
  ),
  returnsBudget: NonNegativeInt,
  status: FactoryRunStatus,
  startedAt: Schema.NullOr(IsoDateTime),
  lastEventAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  frame: Schema.NullOr(
    Schema.Struct({
      repo: Schema.String,
      branch: Schema.String,
      base: Schema.String,
      testLayout: Schema.String,
      checks: Schema.Array(Schema.String),
      suiteAtFrame: Schema.String,
    }),
  ),
  currentPhase: Schema.NullOr(PhaseNumber),
  currentNode: Schema.NullOr(Schema.String),
  phases: Schema.Array(FactoryRunPhase),
  returns: Schema.Array(FactoryRunReturn),
  stops: Schema.Array(FactoryRunStop),
  notes: Schema.Array(
    Schema.Struct({ phase: Schema.NullOr(PhaseNumber), text: Schema.String, at: IsoDateTime }),
  ),
  report: Schema.NullOr(Schema.Struct({ path: Schema.String, at: IsoDateTime })),
  cost: FactoryRunCost,
  clock: FactoryRunClock,
  /** Lines read, decodable or not; a warning's `line` counts from 1 in this sequence. */
  lineCount: NonNegativeInt,
  warningCount: NonNegativeInt,
  /** The first warnings only; `warningCount` keeps counting past them. */
  warnings: Schema.Array(FactoryRunWarning),
});
export type FactoryRunState = typeof FactoryRunState.Type;

/** What the sidebar and the Android thread list show: `phase 5/11 · Review`. */
export const FactoryRunShellSummary = Schema.Struct({
  status: FactoryRunStatus,
  phaseIndex: NonNegativeInt,
  phaseCount: NonNegativeInt,
  node: Schema.NullOr(Schema.String),
});
export type FactoryRunShellSummary = typeof FactoryRunShellSummary.Type;

/** The compact state a run card draws; replaced in place, and under 4 KiB for an 11-phase run. */
export const FactoryRunSummary = Schema.Struct({
  runId: Schema.String,
  runDir: Schema.String,
  status: FactoryRunStatus,
  startedAt: Schema.NullOr(IsoDateTime),
  lastEventAt: Schema.NullOr(IsoDateTime),
  phaseCount: NonNegativeInt,
  phase: Schema.NullOr(Schema.Struct({ index: PhaseNumber, title: Schema.String })),
  node: Schema.NullOr(Schema.String),
  returns: Schema.Struct({ used: NonNegativeInt, budget: NonNegativeInt }),
  verdicts: Schema.Array(
    Schema.Struct({
      phase: PhaseNumber,
      pass: Schema.Literals([1, 2]),
      verdict: FactoryRunVerdict,
    }),
  ),
  cost: FactoryRunCost,
  // Optional: activities stored before these fields existed still decode.
  /** The run's request, shortened. */
  request: Schema.optional(Schema.NullOr(Schema.String)),
  /** One status per phase, in phase order: the card's phase marks. */
  phaseStatuses: Schema.optional(Schema.Array(FactoryRunPhaseStatus)),
  /** The open stop question, shortened; null once answered. */
  question: Schema.optional(Schema.NullOr(Schema.String)),
});
export type FactoryRunSummary = typeof FactoryRunSummary.Type;

/** Payload of a `factory.run` activity. */
export const FactoryRunActivityPayload = Schema.Struct({
  threadId: ThreadId,
  ...FactoryRunSummary.fields,
});
export type FactoryRunActivityPayload = typeof FactoryRunActivityPayload.Type;

/** Payload of a `factory.report` activity: the digest and the headings, never the body. */
export const FactoryReportActivityPayload = Schema.Struct({
  runId: Schema.String,
  digest: FactorySnapshotDigest,
  path: Schema.String,
  title: Schema.String,
  headings: Schema.Array(Schema.String),
  writtenAt: IsoDateTime,
});
export type FactoryReportActivityPayload = typeof FactoryReportActivityPayload.Type;

/** Live progress of one role dispatch, read from its output file while a pane is open. */
export const FactoryRoleProgress = Schema.Struct({
  phase: PhaseNumber,
  role: FactoryRunRole,
  turn: PhaseNumber,
  status: Schema.Literals(["running", "finished"]),
  toolCalls: NonNegativeInt,
  lastTool: Schema.NullOr(Schema.String),
  lastActivityAt: Schema.NullOr(IsoDateTime),
});
export type FactoryRoleProgress = typeof FactoryRoleProgress.Type;

export const FactorySubscribeRunInput = Schema.Struct({
  threadId: ThreadId,
  runId: TrimmedNonEmptyString,
});
export type FactorySubscribeRunInput = typeof FactorySubscribeRunInput.Type;

/** A whole snapshot: a subscriber that skips intermediate items loses nothing. */
export const FactoryRunStreamItem = Schema.Struct({
  state: FactoryRunState,
  /** The dispatches of the current phase, in dispatch order. */
  roles: Schema.Array(FactoryRoleProgress),
});
export type FactoryRunStreamItem = typeof FactoryRunStreamItem.Type;
