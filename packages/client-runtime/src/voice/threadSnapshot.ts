import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2ExecutionNode,
  OrchestrationV2Run,
  OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import type { VoiceConversationSnapshot } from "./conversation.ts";

/** The parts of an orchestration v2 thread projection the voice controller reads. */
export interface VoiceThreadProjection {
  readonly nodes: ReadonlyArray<Pick<OrchestrationV2ExecutionNode, "id" | "parentNodeId" | "kind">>;
  readonly runs: ReadonlyArray<
    Pick<
      OrchestrationV2Run,
      "id" | "ordinal" | "userMessageId" | "rootNodeId" | "status" | "queueHeld" | "startedAt"
    >
  >;
  readonly messages: ReadonlyArray<
    Pick<
      OrchestrationV2ConversationMessage,
      "id" | "role" | "text" | "runId" | "nodeId" | "streaming"
    >
  >;
}

export interface VoiceThreadSnapshotInput {
  readonly projection: VoiceThreadProjection;
  /** The user message of the voice request the call is waiting on, if one is in flight. */
  readonly ownedMessageId: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
}

type Run = VoiceThreadProjection["runs"][number];
type TurnState = NonNullable<VoiceConversationSnapshot["latestTurn"]>["state"];

const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);
/** Run endings that a newer run can replace. A failure is this request's own result. */
const REPLACEABLE_RUN_STATUSES: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  "interrupted",
  "cancelled",
  "rolled_back",
]);

function turnState(status: OrchestrationV2RunStatus): TurnState {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "error";
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return "interrupted";
    case "preparing":
    case "queued":
    case "starting":
    case "running":
    case "waiting":
      return "running";
  }
}

/** A queued run has not executed yet, so it cannot be the thread's latest turn. */
const hasExecuted = (run: Run) => run.status !== "queued";

/**
 * Adapts the v2 thread projection to the controller's snapshot. A run is the controller's turn.
 *
 * The latest turn is the run that owns the in-flight voice request. A later run replaces it only
 * after the owned run stopped without its own result. Without a request, it is the latest run that
 * started executing, so a queued follow-up never hides the result of the run before it.
 */
export function voiceConversationSnapshotFromThread(
  input: VoiceThreadSnapshotInput,
): VoiceConversationSnapshot {
  const runs = [...input.projection.runs].sort((left, right) => left.ordinal - right.ordinal);
  const latestExecuted = runs.findLast(hasExecuted) ?? null;
  const owned =
    input.ownedMessageId === null
      ? null
      : (runs.find((run) => run.userMessageId === input.ownedMessageId) ?? null);
  const replacement =
    owned !== null && REPLACEABLE_RUN_STATUSES.has(owned.status)
      ? (runs.findLast((run) => run.ordinal > owned.ordinal && hasExecuted(run)) ?? null)
      : null;
  const latest = replacement ?? owned ?? latestExecuted;
  const activeRun = runs.findLast((run) => ACTIVE_RUN_STATUSES.has(run.status)) ?? null;
  // Unheld queued runs start next; a voice request waits behind them. A held queue does not block:
  // a client message starts and resumes it.
  const queueWaiting = runs.some((run) => run.status === "queued" && run.queueHeld !== true);

  // Only recent runs matter, so long threads do not copy their whole history on every update.
  const floor = Math.min(latest?.ordinal ?? Infinity, owned?.ordinal ?? Infinity);
  const rootNodeByRun = new Map(
    runs.filter((run) => run.ordinal >= floor).map((run) => [run.id, run.rootNodeId]),
  );
  const nodesById = new Map(input.projection.nodes.map((node) => [node.id, node]));
  const belongsToRootAgent = (
    nodeId: OrchestrationV2ConversationMessage["nodeId"],
    rootNodeId: Run["rootNodeId"],
  ) => {
    if (nodeId === null || rootNodeId === null) return true;
    const visited = new Set<string>();
    let currentId: OrchestrationV2ExecutionNode["parentNodeId"] = nodeId;
    while (currentId !== null && !visited.has(currentId)) {
      if (currentId === rootNodeId) return true;
      visited.add(currentId);
      const node = nodesById.get(currentId);
      if (!node || node.kind === "subagent" || node.kind === "root_turn") return false;
      currentId = node.parentNodeId;
    }
    return false;
  };
  const messages = input.projection.messages
    .filter((message) => {
      if (message.runId === null) return message.id === input.ownedMessageId;
      if (!rootNodeByRun.has(message.runId)) return false;
      // v2 gives each assistant message its own node. Requiring the root node itself dropped
      // real provider replies. Follow parent links, stopping before any subagent boundary.
      return belongsToRootAgent(message.nodeId, rootNodeByRun.get(message.runId) ?? null);
    })
    .map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      turnId: message.runId,
      streaming: message.streaming,
    }));

  const latestTurn =
    latest === null
      ? null
      : {
          turnId: latest.id,
          userMessageId: latest.userMessageId,
          assistantMessageId:
            turnState(latest.status) === "running"
              ? null
              : (messages.findLast(
                  (message) => message.role === "assistant" && message.turnId === latest.id,
                )?.id ?? null),
          state: turnState(latest.status),
        };

  return {
    latestTurn,
    messages,
    session:
      activeRun !== null || queueWaiting
        ? { status: "running", activeTurnId: activeRun?.id ?? null }
        : { status: "idle", activeTurnId: null },
    // A run that failed before it started is a start failure of its request.
    activities: runs
      .filter((run) => run.status === "failed" && run.startedAt === null)
      .map((run) => ({
        kind: "provider.turn.start.failed",
        payload: { requestId: run.userMessageId },
      })),
    hasPendingApprovals: input.hasPendingApprovals,
    hasPendingUserInput: input.hasPendingUserInput,
  };
}
