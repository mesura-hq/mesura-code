/**
 * The fold of a Software Factory run: `events.jsonl` lines in, `FactoryRunState`
 * out. Pure, so the server's run tracker and both clients share one reading of
 * record version 1.
 *
 * The record's single definition is `skills/core/sf-team/bin/run-events.mjs` in
 * the agent-env repository; `factoryRun.test.ts` folds a copy of that skill's
 * fixture, so a change on either side shows up there.
 */
import {
  FACTORY_RUN_RECORD_VERSION,
  FactoryRunEventSchemas,
  type FactoryRunEvent,
  type FactoryRunEventType,
  type FactoryRunPhase,
  type FactoryRunShellSummary,
  type FactoryRunState,
  type FactoryRunStatus,
  type FactoryRunSummary,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

/** The fold keeps this many warnings; `warningCount` counts every one. */
export const FACTORY_RUN_WARNING_LIMIT = 20;

const decoders = Object.fromEntries(
  Object.entries(FactoryRunEventSchemas).map(([type, schema]) => [
    type,
    Schema.decodeUnknownExit(schema as Schema.Codec<FactoryRunEvent, unknown>),
  ]),
) as Record<
  FactoryRunEventType,
  (input: unknown) => Exit.Exit<FactoryRunEvent, Schema.SchemaError>
>;

export type FactoryRunLineDecoding =
  | { readonly event: FactoryRunEvent }
  | { readonly problem: string };

/** Decodes one `events.jsonl` line. Never throws: a line that is not an event names why. */
export function decodeFactoryRunEventLine(line: string): FactoryRunLineDecoding {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    return { problem: `not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { problem: "not a JSON object" };
  }
  const { v, at, type } = value as { v?: unknown; at?: unknown; type?: unknown };
  if (v !== FACTORY_RUN_RECORD_VERSION) {
    return {
      problem: `record version ${JSON.stringify(v)} is not ${FACTORY_RUN_RECORD_VERSION}`,
    };
  }
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) {
    return { problem: `'at' ${JSON.stringify(at)} is not an ISO time` };
  }
  if (typeof type !== "string" || !Object.hasOwn(decoders, type)) {
    return { problem: `unknown event type ${JSON.stringify(type)}` };
  }
  const decoded = decoders[type as FactoryRunEventType](value);
  return Exit.isSuccess(decoded)
    ? { event: decoded.value }
    : { problem: `${type}: ${String(decoded.cause)}` };
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** A run nothing has been read from; its id is the run directory's name until `run.started`. */
export function emptyFactoryRunState(runDir: string): FactoryRunState {
  return {
    runId: basename(runDir),
    runDir,
    request: null,
    planPath: null,
    intentPath: null,
    planDigest: null,
    routes: null,
    returnsBudget: 0,
    status: "running",
    startedAt: null,
    lastEventAt: null,
    finishedAt: null,
    frame: null,
    currentPhase: null,
    currentNode: null,
    phases: [],
    returns: [],
    stops: [],
    notes: [],
    report: null,
    cost: { usd: 0, tokens: {} },
    clock: { elapsedMs: 0, waitingMs: 0, machineMs: 0 },
    lineCount: 0,
    warningCount: 0,
    warnings: [],
  };
}

function emptyPhase(index: number, title: string, acceptance: ReadonlyArray<string>) {
  return {
    index,
    title,
    acceptance,
    status: "pending",
    node: null,
    startedAt: null,
    closedAt: null,
    dispatches: [],
    checks: [],
    verdicts: [],
    findings: [],
    deviations: [],
    degraded: [],
    commit: null,
  } satisfies FactoryRunPhase;
}

/** Replaces one phase, creating it when the plan's list did not name it. */
function updatePhase(
  state: FactoryRunState,
  index: number,
  update: (phase: FactoryRunPhase) => FactoryRunPhase,
): FactoryRunState {
  const existing = state.phases.findIndex((phase) => phase.index === index);
  if (existing === -1) {
    const phases = [...state.phases, update(emptyPhase(index, `Phase ${index}`, []))];
    return { ...state, phases: phases.sort((left, right) => left.index - right.index) };
  }
  const phases = [...state.phases];
  phases[existing] = update(phases[existing]!);
  return { ...state, phases };
}

function deriveStatus(
  state: FactoryRunState,
  finished: "done" | "stopped" | null,
): FactoryRunStatus {
  if (finished === "stopped") return "stopped";
  if (finished === "done") {
    return state.phases.some((phase) => phase.status === "degraded") ? "degraded" : "done";
  }
  return state.stops.some((stop) => stop.answeredAt === null) ? "waiting" : "running";
}

function deriveClock(state: FactoryRunState): FactoryRunState["clock"] {
  if (state.startedAt === null || state.lastEventAt === null) {
    return { elapsedMs: 0, waitingMs: 0, machineMs: 0 };
  }
  const end = Date.parse(state.lastEventAt);
  const elapsedMs = Math.max(0, end - Date.parse(state.startedAt));
  const waitingMs = state.stops.reduce(
    (total, stop) =>
      total +
      Math.max(
        0,
        (stop.answeredAt === null ? end : Date.parse(stop.answeredAt)) - Date.parse(stop.raisedAt),
      ),
    0,
  );
  const waiting = Math.min(waitingMs, elapsedMs);
  return { elapsedMs, waitingMs: waiting, machineMs: elapsedMs - waiting };
}

function addTokens(
  total: Readonly<Record<string, number>>,
  tokens: Readonly<Record<string, number>> | undefined,
): Record<string, number> {
  const next = { ...total };
  for (const [key, count] of Object.entries(tokens ?? {})) next[key] = (next[key] ?? 0) + count;
  return next;
}

function applyEvent(state: FactoryRunState, event: FactoryRunEvent): FactoryRunState {
  switch (event.type) {
    case "run.started":
      return {
        ...state,
        runId: event.runId,
        request: event.request,
        planPath: event.planPath,
        intentPath: event.intentPath,
        planDigest: event.planDigest,
        routes: event.routes,
        returnsBudget: event.returnsBudget,
        startedAt: event.at,
        phases: event.phases.map((phase) => emptyPhase(phase.index, phase.title, phase.acceptance)),
      };
    case "frame.recorded": {
      const { v: _v, at: _at, type: _type, ...frame } = event;
      return { ...state, frame };
    }
    case "phase.started":
      return {
        ...updatePhase(state, event.phase, (phase) => ({
          ...phase,
          status: "running",
          startedAt: event.at,
        })),
        currentPhase: event.phase,
        currentNode: null,
      };
    case "node.entered":
      return {
        ...updatePhase(state, event.phase, (phase) => ({ ...phase, node: event.node })),
        currentPhase: event.phase,
        currentNode: event.node,
      };
    case "dispatch.started":
      return updatePhase(state, event.phase, (phase) => ({
        ...phase,
        dispatches: [
          ...phase.dispatches,
          {
            role: event.role,
            turn: event.turn,
            harness: event.harness,
            model: event.model,
            promptFile: event.promptFile,
            outputFile: event.outputFile,
            sessionId: event.sessionId ?? null,
            startedAt: event.at,
            finishedAt: null,
            stopReason: null,
            costUsd: null,
            tokens: null,
            reportFile: null,
          },
        ],
      }));
    case "dispatch.finished": {
      const next = updatePhase(state, event.phase, (phase) => {
        const index = phase.dispatches.findLastIndex(
          (dispatch) =>
            dispatch.role === event.role &&
            dispatch.turn === event.turn &&
            dispatch.finishedAt === null,
        );
        if (index === -1) return phase;
        const dispatches = [...phase.dispatches];
        dispatches[index] = {
          ...dispatches[index]!,
          sessionId: event.sessionId,
          finishedAt: event.at,
          stopReason: event.stopReason,
          costUsd: event.costUsd ?? null,
          tokens: event.tokens ?? null,
          reportFile: event.reportFile,
        };
        return { ...phase, dispatches };
      });
      return {
        ...next,
        cost: {
          usd: next.cost.usd + (event.costUsd ?? 0),
          tokens: addTokens(next.cost.tokens, event.tokens),
        },
      };
    }
    case "checks.recorded":
      return updatePhase(state, event.phase, (phase) => ({
        ...phase,
        checks: [...phase.checks, { stage: event.stage, at: event.at, results: event.results }],
      }));
    case "verdict.recorded":
      return updatePhase(state, event.phase, (phase) => ({
        ...phase,
        verdicts: [
          ...phase.verdicts,
          {
            pass: event.pass,
            verdict: event.verdict,
            deciding: event.deciding,
            at: event.at,
            criteria: event.criteria,
          },
        ],
      }));
    case "findings.recorded":
      return updatePhase(state, event.phase, (phase) => ({
        ...phase,
        findings: [
          ...phase.findings,
          ...event.findings.map((finding) => ({ ...finding, disposition: null, reason: null })),
        ],
      }));
    case "disposition.recorded":
      return updatePhase(state, event.phase, (phase) => ({
        ...phase,
        findings: phase.findings.map((finding) =>
          finding.id === event.id
            ? { ...finding, disposition: event.disposition, reason: event.reason }
            : finding,
        ),
      }));
    case "return.recorded":
      return {
        ...state,
        returns: [
          ...state.returns,
          {
            phase: event.phase,
            kind: event.kind,
            n: event.n,
            budget: event.budget,
            node: event.node,
            change: event.change,
            at: event.at,
          },
        ],
      };
    case "deviation.recorded":
      return updatePhase(state, event.phase, (phase) => ({
        ...phase,
        deviations: [
          ...phase.deviations,
          { path: event.path, kind: event.kind, reason: event.reason },
        ],
      }));
    case "stop.raised":
      return {
        ...state,
        stops: [
          ...state.stops,
          {
            phase: event.phase ?? null,
            node: event.node ?? null,
            question: event.question,
            options: event.options,
            raisedAt: event.at,
            answeredAt: null,
            answer: null,
          },
        ],
      };
    case "stop.answered": {
      const index = state.stops.findLastIndex((stop) => stop.answeredAt === null);
      if (index === -1) return state;
      const stops = [...state.stops];
      stops[index] = { ...stops[index]!, answeredAt: event.at, answer: event.answer };
      return { ...state, stops };
    }
    case "note":
      return {
        ...state,
        notes: [...state.notes, { phase: event.phase ?? null, text: event.text, at: event.at }],
      };
    case "phase.closed":
      return updatePhase(state, event.phase, (phase) => ({
        ...phase,
        status: event.close === "clean" ? "clean" : "degraded",
        degraded: event.close === "clean" ? [] : event.close.degraded,
        closedAt: event.at,
        commit: event.commit ?? null,
      }));
    case "report.written":
      return { ...state, report: { path: event.path, at: event.at } };
    case "run.finished":
      return { ...state, finishedAt: event.at };
  }
}

/** Folds one decoded event, then re-derives the status and the clock. */
export function foldFactoryRunEvents(
  state: FactoryRunState,
  event: FactoryRunEvent,
): FactoryRunState {
  const applied = applyEvent(state, event);
  const lastEventAt =
    applied.lastEventAt === null || event.at > applied.lastEventAt ? event.at : applied.lastEventAt;
  const next = { ...applied, lastEventAt };
  const finished = event.type === "run.finished" ? event.status : finishedStatus(state);
  return { ...next, status: deriveStatus(next, finished), clock: deriveClock(next) };
}

function finishedStatus(state: FactoryRunState): "done" | "stopped" | null {
  if (state.finishedAt === null) return null;
  return state.status === "stopped" ? "stopped" : "done";
}

/**
 * Folds one `events.jsonl` line. A line that is not a record-version-1 event
 * is skipped and counted in the warnings; it never stops the fold.
 */
export function foldFactoryRunLine(state: FactoryRunState, line: string): FactoryRunState {
  const lineCount = state.lineCount + 1;
  const decoded = decodeFactoryRunEventLine(line);
  if ("event" in decoded) return foldFactoryRunEvents({ ...state, lineCount }, decoded.event);
  return {
    ...state,
    lineCount,
    warningCount: state.warningCount + 1,
    warnings:
      state.warnings.length < FACTORY_RUN_WARNING_LIMIT
        ? [...state.warnings, { line: lineCount, problem: decoded.problem }]
        : state.warnings,
  };
}

function currentPhaseOf(state: FactoryRunState) {
  return state.currentPhase === null
    ? undefined
    : state.phases.find((phase) => phase.index === state.currentPhase);
}

/**
 * The most bytes the encoded summary may take. A `factory.run` activity adds the
 * thread id to it and stays under 4 KiB; every client replays these activities.
 */
export const FACTORY_RUN_SUMMARY_MAX_BYTES = 4096 - 256;
const SUMMARY_TITLE_MAX_CHARS = 160;
const SUMMARY_NODE_MAX_CHARS = 64;

function shorten(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

const encodedBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/**
 * The compact summary a `factory.run` activity carries, bounded by
 * `FACTORY_RUN_SUMMARY_MAX_BYTES`: the phase title and the node are shortened,
 * then the oldest phases' verdicts are dropped. The full state keeps them whole.
 */
export function summarizeFactoryRun(state: FactoryRunState): FactoryRunSummary {
  const summary = unboundedSummary(state);
  const bounded: FactoryRunSummary = {
    ...summary,
    phase:
      summary.phase === null
        ? null
        : { ...summary.phase, title: shorten(summary.phase.title, SUMMARY_TITLE_MAX_CHARS) },
    node: summary.node === null ? null : shorten(summary.node, SUMMARY_NODE_MAX_CHARS),
  };
  let verdicts = bounded.verdicts;
  while (
    verdicts.length > 0 &&
    encodedBytes({ ...bounded, verdicts }) > FACTORY_RUN_SUMMARY_MAX_BYTES
  ) {
    const oldestPhase = verdicts[0]!.phase;
    verdicts = verdicts.filter((verdict) => verdict.phase !== oldestPhase);
  }
  return { ...bounded, verdicts };
}

function unboundedSummary(state: FactoryRunState): FactoryRunSummary {
  const phase = currentPhaseOf(state);
  return {
    runId: state.runId,
    runDir: state.runDir,
    status: state.status,
    startedAt: state.startedAt,
    lastEventAt: state.lastEventAt,
    phaseCount: state.phases.length,
    phase: phase === undefined ? null : { index: phase.index, title: phase.title },
    node: state.currentNode,
    returns: { used: state.returns.length, budget: state.returnsBudget },
    // The newest verdict of each pass, per phase.
    verdicts: state.phases.flatMap((candidate) =>
      ([1, 2] as const).flatMap((pass) => {
        const verdict = candidate.verdicts.findLast((recorded) => recorded.pass === pass);
        return verdict === undefined
          ? []
          : [{ phase: candidate.index, pass, verdict: verdict.verdict }];
      }),
    ),
    cost: state.cost,
  };
}

/** The label a thread row shows: status, `phase i/n`, node. */
export function toFactoryRunShellSummary(state: FactoryRunState): FactoryRunShellSummary {
  return {
    status: state.status,
    phaseIndex: state.currentPhase ?? 0,
    phaseCount: state.phases.length,
    node: state.currentNode,
  };
}
