/**
 * What the Factory pane's Run tab draws, from one `subscribeFactoryRun` item.
 * The components only render this model; every decision about a run's shape
 * (which phase is shown, which node is in flight, where a return went back
 * to, what the clock and the cost read) is made here.
 */
import {
  isFactoryRunFinished,
  type FactoryRoleProgress,
  type FactoryRunDispatch,
  type FactoryRunPhase,
  type FactoryRunPhaseStatus,
  type FactoryRunRole,
  type FactoryRunState,
  type FactoryRunStreamItem,
  type FactoryRunVerdict,
} from "@t3tools/contracts";
import {
  factoryCostText,
  factoryNodeDisplayName,
} from "@t3tools/client-runtime/factory/run-presentation";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

/** A phase of a stopped run that never closed reads `stopped`, not `running`. */
export type FactoryRailStatus = FactoryRunPhaseStatus | "stopped";

export interface FactoryRailItem {
  readonly index: number;
  readonly title: string;
  readonly status: FactoryRailStatus;
  readonly selected: boolean;
}

export type FactorySpineNodeStatus = "done" | "current" | "pending" | "stopped";
export type FactorySpineStage = "Build" | "Harden" | "Close";

export interface FactorySpineNode {
  readonly node: string;
  readonly label: string;
  readonly status: FactorySpineNodeStatus;
}

export interface FactoryReturnEdge {
  /** The node that said no. */
  readonly from: string;
  /** The spine node the phase re-entered, or the implementer's node while it holds the return. */
  readonly to: string;
  readonly kind: "repair" | "rework";
  readonly signal: string;
  /** `repair 2/5 — Verify ①: <change>`. */
  readonly text: string;
  /** The implementer still holds it: the phase has not re-entered the spine. */
  readonly pending: boolean;
}

export interface FactorySpineView {
  readonly stages: ReadonlyArray<{
    readonly stage: FactorySpineStage;
    readonly nodes: ReadonlyArray<FactorySpineNode>;
  }>;
  readonly returns: ReadonlyArray<FactoryReturnEdge>;
}

export interface FactoryRoleTurn {
  readonly turn: number;
  readonly status: "running" | "finished";
  readonly promptFile: string;
  readonly reportFile: string | null;
}

/** One role session of a phase: the turns it was resumed for. */
export interface FactoryRoleSessionRow {
  readonly key: string;
  readonly role: FactoryRunRole;
  readonly harness: string;
  readonly model: string;
  readonly sessionId: string | null;
  readonly turnCount: number;
  readonly status: "running" | "finished";
  /** Live progress of the running turn; null once finished. */
  readonly toolCalls: number | null;
  readonly lastTool: string | null;
  readonly lastActivityAt: string | null;
  /** Dollars or tokens once every turn finished; null while one runs. */
  readonly cost: string | null;
  readonly turns: ReadonlyArray<FactoryRoleTurn>;
}

export interface FactoryPhaseDetail {
  readonly verdicts: ReadonlyArray<{
    readonly pass: 1 | 2;
    readonly label: string;
    readonly verdict: FactoryRunVerdict;
    readonly deciding: string;
  }>;
  readonly findings: FactoryRunPhase["findings"];
  readonly checks: FactoryRunPhase["checks"];
  readonly deviations: FactoryRunPhase["deviations"];
  readonly degraded: FactoryRunPhase["degraded"];
  readonly commit: FactoryRunPhase["commit"];
}

export interface FactoryRunTotals {
  readonly elapsedMs: number;
  readonly waitingMs: number;
  readonly elapsed: string;
  readonly waiting: string;
  readonly cost: string;
  /** The dollar figure leaves out turns that reported only tokens. */
  readonly costIsFloor: boolean;
}

export interface FactoryRunView {
  /** Running or waiting: the clock is closed with the client's time. */
  readonly live: boolean;
  readonly rail: ReadonlyArray<FactoryRailItem>;
  readonly selectedPhase: number | null;
  readonly spine: FactorySpineView | null;
  readonly roles: ReadonlyArray<FactoryRoleSessionRow>;
  readonly detail: FactoryPhaseDetail | null;
  readonly totals: FactoryRunTotals;
}

/** The spine of every phase, in sf-team's order. `repair` is the return node, off the spine. */
const SPINE: ReadonlyArray<{ stage: FactorySpineStage; nodes: ReadonlyArray<string> }> = [
  { stage: "Build", nodes: ["fence", "implement", "checks-build", "verify-1"] },
  { stage: "Harden", nodes: ["review", "rework", "regression", "checks-harden", "verify-2"] },
  { stage: "Close", nodes: ["commit"] },
];
const SPINE_NODES = SPINE.flatMap((stage) => stage.nodes);

function resolveSelectedPhase(state: FactoryRunState, requested: number | null): number | null {
  if (requested !== null && state.phases.some((phase) => phase.index === requested)) {
    return requested;
  }
  return state.currentPhase ?? state.phases[0]?.index ?? null;
}

function railStatus(state: FactoryRunState, phase: FactoryRunPhase): FactoryRailStatus {
  return phase.status === "running" && state.status === "stopped" ? "stopped" : phase.status;
}

function returnEdges(state: FactoryRunState, phaseIndex: number): ReadonlyArray<FactoryReturnEdge> {
  return state.returns
    .filter((entry) => entry.phase === phaseIndex)
    .map((entry) => ({
      from: entry.node,
      to: entry.reentered ?? entry.kind,
      kind: entry.kind,
      signal: entry.change,
      text: `${entry.kind} ${entry.n}/${entry.budget} — ${factoryNodeDisplayName(entry.node)}: ${entry.change}`,
      pending: entry.reentered === undefined,
    }));
}

/**
 * Where the running phase stands on the spine: the index of its node, or,
 * while the implementer holds a repair off the spine, the node that said no
 * (which runs again once the repair is done). -1 before the first node.
 */
function spinePosition(
  phase: FactoryRunPhase,
  edges: ReadonlyArray<FactoryReturnEdge>,
): { index: number; onSpine: boolean } {
  const onSpine = phase.node === null ? -1 : SPINE_NODES.indexOf(phase.node);
  if (onSpine !== -1) return { index: onSpine, onSpine: true };
  const heldReturn = edges.findLast((edge) => edge.pending);
  return { index: heldReturn ? SPINE_NODES.indexOf(heldReturn.from) : -1, onSpine: false };
}

function spineNodeStatuses(
  state: FactoryRunState,
  phase: FactoryRunPhase,
  edges: ReadonlyArray<FactoryReturnEdge>,
): ReadonlyArray<FactorySpineNodeStatus> {
  if (phase.status === "clean" || phase.status === "degraded") {
    return SPINE_NODES.map(() => "done");
  }
  if (phase.status === "pending") return SPINE_NODES.map(() => "pending");
  const position = spinePosition(phase, edges);
  const inFlight: FactorySpineNodeStatus = state.status === "stopped" ? "stopped" : "current";
  return SPINE_NODES.map((_, index) => {
    if (index < position.index) return "done";
    if (index === position.index && position.onSpine) return inFlight;
    return "pending";
  });
}

function spineView(state: FactoryRunState, phase: FactoryRunPhase): FactorySpineView {
  const returns = returnEdges(state, phase.index);
  const statuses = spineNodeStatuses(state, phase, returns);
  let offset = 0;
  const stages = SPINE.map(({ stage, nodes }) => {
    const stageNodes = nodes.map((node, index) => ({
      node,
      label: factoryNodeDisplayName(node),
      status: statuses[offset + index]!,
    }));
    offset += nodes.length;
    return { stage, nodes: stageNodes };
  });
  return { stages, returns };
}

/**
 * A dispatch resumes a session only when the record names that session. A
 * turn started without an id is a fresh session (a Codex thread learns its id
 * only when it finishes), so it keeps its own row rather than borrowing an
 * earlier session's id and turn count.
 */
function sameSession(
  row: { role: FactoryRunRole; sessionId: string | null },
  dispatch: FactoryRunDispatch,
) {
  return (
    row.role === dispatch.role &&
    row.sessionId !== null &&
    dispatch.sessionId !== null &&
    row.sessionId === dispatch.sessionId
  );
}

function roleSessionRows(
  phase: FactoryRunPhase,
  progress: ReadonlyArray<FactoryRoleProgress>,
): ReadonlyArray<FactoryRoleSessionRow> {
  const sessions: Array<{
    role: FactoryRunRole;
    sessionId: string | null;
    dispatches: FactoryRunDispatch[];
  }> = [];
  for (const dispatch of phase.dispatches) {
    const session = sessions.find((candidate) => sameSession(candidate, dispatch));
    if (session === undefined) {
      sessions.push({ role: dispatch.role, sessionId: dispatch.sessionId, dispatches: [dispatch] });
    } else {
      session.dispatches.push(dispatch);
      session.sessionId ??= dispatch.sessionId;
    }
  }
  return sessions.map((session) => {
    const latest = session.dispatches[session.dispatches.length - 1]!;
    const running = session.dispatches.find((dispatch) => dispatch.finishedAt === null);
    const live =
      running === undefined
        ? undefined
        : progress.find(
            (item) =>
              item.phase === phase.index &&
              item.role === running.role &&
              item.turn === running.turn,
          );
    return {
      // The first turn names the row: stable while the session's id is still unknown.
      key: `${phase.index}:${session.role}:${session.dispatches[0]!.turn}`,
      role: session.role,
      harness: latest.harness,
      model: latest.model,
      sessionId: session.sessionId,
      turnCount: session.dispatches.length,
      status: running === undefined ? "finished" : "running",
      toolCalls: live?.toolCalls ?? null,
      lastTool: live?.lastTool ?? null,
      lastActivityAt: live?.lastActivityAt ?? null,
      cost: running === undefined ? sessionCost(session.dispatches) : null,
      turns: session.dispatches.map((dispatch) => ({
        turn: dispatch.turn,
        status: dispatch.finishedAt === null ? "running" : "finished",
        promptFile: dispatch.promptFile,
        reportFile: dispatch.reportFile,
      })),
    };
  });
}

function sessionCost(dispatches: ReadonlyArray<FactoryRunDispatch>): string | null {
  let usd = 0;
  const tokens: Record<string, number> = {};
  let reported = false;
  for (const dispatch of dispatches) {
    if (dispatch.costUsd !== null) {
      usd += dispatch.costUsd;
      reported = true;
    }
    for (const [key, count] of Object.entries(dispatch.tokens ?? {})) {
      tokens[key] = (tokens[key] ?? 0) + count;
      reported = true;
    }
  }
  return reported ? factoryCostText({ usd, tokens }).text : null;
}

function phaseDetail(phase: FactoryRunPhase): FactoryPhaseDetail {
  return {
    verdicts: phase.verdicts.map((verdict) => ({
      pass: verdict.pass,
      label: factoryNodeDisplayName(`verify-${verdict.pass}`),
      verdict: verdict.verdict,
      deciding: verdict.deciding,
    })),
    findings: phase.findings,
    checks: phase.checks,
    deviations: phase.deviations,
    degraded: phase.degraded,
    commit: phase.commit,
  };
}

/** Below a second the clock reads `0s`; `formatDuration` would say `1ms`. */
const clockText = (ms: number) => (ms < 1_000 ? "0s" : formatDuration(ms));

/**
 * The run's totals. A finished run keeps the fold's clock. A live run closes
 * its open interval with the client's clock: elapsed runs to now, and an open
 * question's wait runs from the moment it was raised to now. Separate from
 * the rest of the view so only the totals repaint as the clock ticks.
 */
export function deriveFactoryRunTotals(state: FactoryRunState, nowMs: number): FactoryRunTotals {
  const live = !isFactoryRunFinished(state.status);
  let { elapsedMs, waitingMs } = state.clock;
  if (live && state.startedAt !== null) {
    elapsedMs = Math.max(elapsedMs, nowMs - Date.parse(state.startedAt));
    waitingMs = state.stops.reduce(
      (total, stop) =>
        total +
        Math.max(
          0,
          (stop.answeredAt === null ? nowMs : Date.parse(stop.answeredAt)) -
            Date.parse(stop.raisedAt),
        ),
      0,
    );
    waitingMs = Math.min(waitingMs, elapsedMs);
  }
  const cost = factoryCostText(state.cost);
  return {
    elapsedMs,
    waitingMs,
    elapsed: clockText(elapsedMs),
    waiting: clockText(waitingMs),
    cost: cost.text,
    costIsFloor: cost.floor,
  };
}

/**
 * A session's turn files as markdown the chat draws as file chips, one line
 * per turn. Paths are written by the composer's own serializer, so any legal
 * path (spaces, brackets, angle brackets, parentheses) stays one link.
 */
export function factoryTurnFilesMarkdown(turns: ReadonlyArray<FactoryRoleTurn>): string {
  return turns
    .map((turn) =>
      [
        `Turn ${turn.turn}:`,
        serializeComposerFileLink(turn.promptFile),
        turn.reportFile === null ? "running" : serializeComposerFileLink(turn.reportFile),
      ].join(" "),
    )
    .join("\n\n");
}

const sameTurn = (left: FactoryRoleTurn, right: FactoryRoleTurn) =>
  left.turn === right.turn &&
  left.status === right.status &&
  left.promptFile === right.promptFile &&
  left.reportFile === right.reportFile;

/**
 * Keeps the previous view's row and turn objects where nothing in them
 * changed, so a stream item that moves one role leaves the other rows, and
 * their parsed file links, untouched.
 */
function reuseUnchangedRows(
  rows: ReadonlyArray<FactoryRoleSessionRow>,
  previous: ReadonlyArray<FactoryRoleSessionRow>,
): ReadonlyArray<FactoryRoleSessionRow> {
  return rows.map((row) => {
    const before = previous.find((candidate) => candidate.key === row.key);
    if (before === undefined) return row;
    const turns = row.turns.map((turn) => {
      const earlier = before.turns.find((candidate) => candidate.turn === turn.turn);
      return earlier !== undefined && sameTurn(earlier, turn) ? earlier : turn;
    });
    const turnsUnchanged =
      turns.length === before.turns.length &&
      turns.every((turn, index) => turn === before.turns[index]);
    const next = { ...row, turns: turnsUnchanged ? before.turns : turns };
    const unchanged =
      turnsUnchanged &&
      (Object.keys(row) as Array<keyof FactoryRoleSessionRow>).every(
        (field) => field === "turns" || before[field] === next[field],
      );
    return unchanged ? before : next;
  });
}

export function deriveFactoryRunView(input: {
  readonly item: FactoryRunStreamItem;
  /** The phase the reader picked on the rail; null follows the run's current phase. */
  readonly selectedPhase: number | null;
  readonly nowMs: number;
  /** The view drawn before this item: rows that did not change keep their identity. */
  readonly previous?: FactoryRunView | null;
}): FactoryRunView {
  const { state, roles } = input.item;
  const live = !isFactoryRunFinished(state.status);
  const selectedPhase = resolveSelectedPhase(state, input.selectedPhase);
  const phase = state.phases.find((candidate) => candidate.index === selectedPhase) ?? null;
  return {
    live,
    rail: state.phases.map((candidate) => ({
      index: candidate.index,
      title: candidate.title,
      status: railStatus(state, candidate),
      selected: candidate.index === selectedPhase,
    })),
    selectedPhase,
    spine: phase === null ? null : spineView(state, phase),
    roles:
      phase === null
        ? []
        : reuseUnchangedRows(roleSessionRows(phase, roles), input.previous?.roles ?? []),
    detail: phase === null ? null : phaseDetail(phase),
    totals: deriveFactoryRunTotals(state, input.nowMs),
  };
}
