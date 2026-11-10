/**
 * A Software Factory run as a trace: where its wall clock went. One lane per
 * phase holds each role turn, labelled by the spine node it ran in; stops
 * that waited for the developer are their own intervals. Pure, derived from
 * the fold, so the server's run summary and the clients draw the same run.
 */
import type { FactoryRunRole, FactoryRunState } from "@t3tools/contracts";

export interface FactoryTraceTurn {
  readonly key: string;
  readonly role: FactoryRunRole;
  readonly turn: number;
  /** The spine node the turn started in (fence, implement, rework, …): why the role was called. */
  readonly node: string | null;
  readonly model: string;
  readonly harness: string;
  readonly startMs: number;
  /** Null while the turn runs, or when a stopped run left it unfinished; drawn to the trace's end. */
  readonly endMs: number | null;
  /** True when the run stopped while this turn had not finished: it will never finish. */
  readonly interrupted: boolean;
  /** The turn's own spend; see `FactoryRunDispatch.costUsd`. */
  readonly costUsd: number | null;
  /** Input plus output tokens, under Codex's own counting; null when the turn reported none. */
  readonly tokens: number | null;
}

export interface FactoryTraceStop {
  readonly phase: number | null;
  readonly question: string;
  readonly startMs: number;
  readonly endMs: number | null;
}

export interface FactoryTracePhase {
  readonly index: number;
  readonly title: string;
  /** A phase still running when its run stopped reads `stopped`, as the old phase rail did. */
  readonly status: FactoryRunState["phases"][number]["status"] | "stopped";
  readonly startMs: number | null;
  readonly endMs: number | null;
  readonly turns: ReadonlyArray<FactoryTraceTurn>;
  readonly costUsd: number;
  readonly tokens: number;
}

export interface FactoryTraceRoleTotal {
  readonly role: FactoryRunRole;
  readonly ms: number;
  readonly costUsd: number;
  readonly tokens: number;
  readonly turns: number;
}

/** Four shares of the wall clock that add up to it. */
export interface FactoryTraceTotals {
  readonly wallMs: number;
  /** The union of every role turn. */
  readonly agentMs: number;
  /** The union of every stop, less the time a role was still working through it. */
  readonly waitingMs: number;
  /** The rest: the coordinator's own work, the checks and the hand-offs between roles. */
  readonly coordinatorMs: number;
  readonly costUsd: number;
  readonly tokens: number;
  readonly byRole: ReadonlyArray<FactoryTraceRoleTotal>;
}

export interface FactoryTrace {
  readonly startMs: number;
  readonly endMs: number;
  readonly live: boolean;
  readonly phases: ReadonlyArray<FactoryTracePhase>;
  readonly stops: ReadonlyArray<FactoryTraceStop>;
  readonly totals: FactoryTraceTotals;
}

const ROLES: ReadonlyArray<FactoryRunRole> = ["implementer", "verifier", "reviewer"];

const parse = (iso: string | null) => (iso === null ? null : Date.parse(iso));

type Interval = readonly [number, number];

/** The intervals merged where they overlap, in order. */
function mergeIntervals(intervals: ReadonlyArray<Interval>): Interval[] {
  const sorted = intervals
    .filter(([start, end]) => end > start)
    .sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

const lengthOf = (intervals: ReadonlyArray<Interval>) =>
  intervals.reduce((total, [start, end]) => total + (end - start), 0);

/** The part of `intervals` that `cover` does not overlap. */
function subtractIntervals(
  intervals: ReadonlyArray<Interval>,
  cover: ReadonlyArray<Interval>,
): Interval[] {
  const remaining: Interval[] = [];
  for (const [start, end] of intervals) {
    let cursor = start;
    for (const [coverStart, coverEnd] of cover) {
      if (coverEnd <= cursor || coverStart >= end) continue;
      if (coverStart > cursor) remaining.push([cursor, coverStart]);
      cursor = Math.max(cursor, coverEnd);
    }
    if (cursor < end) remaining.push([cursor, end]);
  }
  return remaining;
}

const tokenTotal = (tokens: Readonly<Record<string, number>> | null) =>
  tokens === null ? null : (tokens.input_tokens ?? 0) + (tokens.output_tokens ?? 0);

/**
 * The run as a trace. A live run is drawn to `nowMs`, or to its last event
 * when that is later; a finished run ends at `run.finished`.
 */
export function deriveFactoryRunTrace(state: FactoryRunState, nowMs: number): FactoryTrace | null {
  const startMs = parse(state.startedAt);
  if (startMs === null) return null;
  const live = state.finishedAt === null;
  const lastEventMs = parse(state.lastEventAt) ?? startMs;
  const endMs = live ? Math.max(nowMs, lastEventMs) : Math.max(startMs, parse(state.finishedAt)!);
  const closeAt = (ms: number | null) => ms ?? endMs;

  const phases = state.phases.map((phase): FactoryTracePhase => {
    const turns = phase.dispatches.map((dispatch): FactoryTraceTurn => {
      const turnStart = Date.parse(dispatch.startedAt);
      return {
        key: `${phase.index}:${dispatch.role}:${dispatch.turn}:${dispatch.startedAt}`,
        role: dispatch.role,
        turn: dispatch.turn,
        node: phase.nodes.findLast((entry) => Date.parse(entry.at) <= turnStart)?.node ?? null,
        model: dispatch.model,
        harness: dispatch.harness,
        startMs: turnStart,
        endMs: parse(dispatch.finishedAt),
        interrupted: !live && dispatch.finishedAt === null,
        costUsd: dispatch.costUsd,
        tokens: tokenTotal(dispatch.tokens),
      };
    });
    return {
      index: phase.index,
      title: phase.title,
      status: phase.status === "running" && state.status === "stopped" ? "stopped" : phase.status,
      startMs: parse(phase.startedAt),
      endMs: parse(phase.closedAt),
      turns,
      costUsd: turns.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0),
      tokens: turns.reduce((sum, turn) => sum + (turn.tokens ?? 0), 0),
    };
  });

  const stops = state.stops.map((stop): FactoryTraceStop => ({
    phase: stop.phase,
    question: stop.question,
    startMs: Date.parse(stop.raisedAt),
    endMs: parse(stop.answeredAt),
  }));

  const allTurns = phases.flatMap((phase) => phase.turns);
  const turnIntervals = (turns: ReadonlyArray<FactoryTraceTurn>) =>
    mergeIntervals(turns.map((turn) => [turn.startMs, closeAt(turn.endMs)] as const));
  const agentIntervals = turnIntervals(allTurns);
  const stopIntervals = mergeIntervals(
    stops.map((stop) => [stop.startMs, closeAt(stop.endMs)] as const),
  );
  const wallMs = endMs - startMs;
  const agentMs = lengthOf(agentIntervals);
  const waitingMs = lengthOf(subtractIntervals(stopIntervals, agentIntervals));
  const sum = (turns: ReadonlyArray<FactoryTraceTurn>, pick: (turn: FactoryTraceTurn) => number) =>
    turns.reduce((total, turn) => total + pick(turn), 0);
  return {
    startMs,
    endMs,
    live,
    phases,
    stops,
    totals: {
      wallMs,
      agentMs,
      waitingMs,
      coordinatorMs: Math.max(0, wallMs - agentMs - waitingMs),
      costUsd: sum(allTurns, (turn) => turn.costUsd ?? 0),
      tokens: sum(allTurns, (turn) => turn.tokens ?? 0),
      byRole: ROLES.map((role) => {
        const turns = allTurns.filter((turn) => turn.role === role);
        return {
          role,
          ms: lengthOf(turnIntervals(turns)),
          costUsd: sum(turns, (turn) => turn.costUsd ?? 0),
          tokens: sum(turns, (turn) => turn.tokens ?? 0),
          turns: turns.length,
        };
      }),
    },
  };
}

/**
 * The strip's alphabet: one character per slice of the wall clock, naming
 * what filled most of it. A role, a stop that waited for the developer, the
 * coordinator inside a phase, or nothing (between phases).
 */
export const FACTORY_TRACE_STRIP_CODES = {
  i: "implementer",
  v: "verifier",
  r: "reviewer",
  w: "waiting",
  c: "coordinator",
  ".": "idle",
} as const;
export type FactoryTraceStripKind =
  (typeof FACTORY_TRACE_STRIP_CODES)[keyof typeof FACTORY_TRACE_STRIP_CODES];

export const FACTORY_TRACE_STRIP_SLICES = 96;

const ROLE_CODE: Record<FactoryRunRole, string> = {
  implementer: "i",
  verifier: "v",
  reviewer: "r",
};

/** How much of `[from, to)` the intervals cover. */
function overlapMs(intervals: ReadonlyArray<Interval>, from: number, to: number): number {
  let total = 0;
  for (const [start, end] of intervals) {
    const overlap = Math.min(end, to) - Math.max(start, from);
    if (overlap > 0) total += overlap;
  }
  return total;
}

/**
 * The trace in `FACTORY_TRACE_STRIP_SLICES` characters, small enough for the
 * run summary every card reads. A role wins its slice when it filled the
 * largest part of it; a stop wins only where no role worked.
 */
export function encodeFactoryTraceStrip(trace: FactoryTrace): string {
  const length = Math.max(1, trace.endMs - trace.startMs);
  const slice = length / FACTORY_TRACE_STRIP_SLICES;
  const closeAt = (ms: number | null) => ms ?? trace.endMs;
  const allTurns = trace.phases.flatMap((phase) => phase.turns);
  const byRole = ROLES.map(
    (role) =>
      [
        ROLE_CODE[role],
        mergeIntervals(
          allTurns
            .filter((turn) => turn.role === role)
            .map((turn) => [turn.startMs, closeAt(turn.endMs)] as const),
        ),
      ] as const,
  );
  const stopIntervals = mergeIntervals(
    trace.stops.map((stop) => [stop.startMs, closeAt(stop.endMs)] as const),
  );
  const phaseIntervals = mergeIntervals(
    trace.phases.flatMap((phase) =>
      phase.startMs === null ? [] : [[phase.startMs, closeAt(phase.endMs)] as const],
    ),
  );
  let strip = "";
  for (let index = 0; index < FACTORY_TRACE_STRIP_SLICES; index += 1) {
    const from = trace.startMs + index * slice;
    const to = from + slice;
    let code = ".";
    let best = 0;
    for (const [roleCode, intervals] of byRole) {
      const covered = overlapMs(intervals, from, to);
      if (covered > best) {
        best = covered;
        code = roleCode;
      }
    }
    if (best === 0) {
      if (overlapMs(stopIntervals, from, to) > 0) code = "w";
      else if (overlapMs(phaseIntervals, from, to) > 0) code = "c";
    }
    strip += code;
  }
  return strip;
}

/** Runs of one kind across the strip, as fractions of its width, for drawing. */
export function decodeFactoryTraceStrip(strip: string): ReadonlyArray<{
  readonly kind: FactoryTraceStripKind;
  readonly start: number;
  readonly width: number;
}> {
  const segments: Array<{ kind: FactoryTraceStripKind; start: number; width: number }> = [];
  const count = Math.max(1, strip.length);
  for (let index = 0; index < strip.length; index += 1) {
    const char = strip[index]!;
    const kind =
      FACTORY_TRACE_STRIP_CODES[char as keyof typeof FACTORY_TRACE_STRIP_CODES] ?? "idle";
    const last = segments.at(-1);
    if (last !== undefined && last.kind === kind) last.width += 1 / count;
    else segments.push({ kind, start: index / count, width: 1 / count });
  }
  return segments.filter((segment) => segment.kind !== "idle");
}

/** `12h 18m`, `9m`, `40s`: minutes are the grain of a run. */
export function factoryTraceDurationText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

/** `150M`, `2.1M`, `35k`, `900`. */
export function factoryTraceTokenText(tokens: number): string {
  if (tokens >= 10_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/** `$3.67`, `$58`. */
export const factoryTraceUsdText = (usd: number) =>
  `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(0)}`;
