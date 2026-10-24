import {
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadProjection,
  type ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  NodeId,
  ProviderSessionId,
  TurnItemId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ThreadId,
} from "@t3tools/contracts";
import {
  presentThreadShell,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import * as DateTime from "effect/DateTime";

/**
 * Mesura: one thread shell for the AppRoot fence tests, in the orchestrator-v2
 * shape the stores hand ChatView and the sidebar. Built through the client's own
 * `presentThreadShell`, so a fence sees exactly what a live server would give it.
 */
export function makeFenceThreadShell(input: {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title?: string;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly modelSelection?: OrchestrationV2ThreadShell["modelSelection"];
  readonly runtimeMode?: OrchestrationV2ThreadShell["runtimeMode"];
  readonly interactionMode?: OrchestrationV2ThreadShell["interactionMode"];
  readonly createdAt?: string;
  readonly overrides?: Partial<OrchestrationV2ThreadShell>;
}): EnvironmentThreadShell {
  const at = DateTime.makeUnsafe(input.createdAt ?? "2026-09-01T00:00:00.000Z");
  const modelSelection = input.modelSelection ?? {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  };
  return presentThreadShell(input.environmentId, {
    id: input.id,
    projectId: input.projectId,
    title: input.title ?? "Fence thread",
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: input.interactionMode ?? "default",
    branch: input.branch ?? null,
    worktreePath: input.worktreePath ?? null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: input.id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...input.overrides,
  });
}

/** A v2 detail projection for the same shell, with explicit collections for each read boundary. */
export function makeFenceThreadProjection(
  shell: EnvironmentThreadShell,
  overrides: Partial<OrchestrationV2ThreadProjection> = {},
): OrchestrationV2ThreadProjection {
  return {
    thread: { ...shell.source, lastVisitedAt: shell.source.lastVisitedAt ?? null },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: shell.source.updatedAt,
    ...overrides,
  };
}

/** Builds the joined v2 request entity and display item from the question contract. */
export function makeFenceUserInput(input: {
  readonly threadId: ThreadId;
  readonly requestId: string;
  readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
  readonly createdAt: string;
  readonly responseMode?: "message";
  readonly ordinal?: number;
}) {
  const requestId = RuntimeRequestId.make(input.requestId);
  const nodeId = NodeId.make(`question:${requestId}`);
  const at = DateTime.makeUnsafe(input.createdAt);
  const request: OrchestrationV2RuntimeRequest = {
    id: requestId,
    nodeId,
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "user_input",
    status: "pending",
    responseCapability:
      input.responseMode === "message"
        ? { type: "message" }
        : { type: "live", providerSessionId: ProviderSessionId.make("fence-question-session") },
    createdAt: at,
    resolvedAt: null,
  };
  const item: Extract<OrchestrationV2TurnItem, { type: "user_input_request" }> = {
    id: TurnItemId.make(`question-item:${requestId}`),
    threadId: input.threadId,
    runId: null,
    nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal ?? 0,
    status: "completed",
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    type: "user_input_request",
    requestId,
    questions: input.questions,
    ...(input.responseMode === undefined ? {} : { responseMode: input.responseMode }),
  };
  return { request, item };
}

/** The retained pending-input fences share one request with two independent questions. */
export const FENCE_USER_INPUT_QUESTIONS: ReadonlyArray<OrchestrationV2UserInputQuestion> = [
  {
    id: "scope",
    header: "Scope",
    question: "Which scope first?",
    multiSelect: true,
    options: [{ label: "Workspace", description: "Current workspace" }],
  },
  {
    id: "timing",
    header: "Timing",
    question: "When should it run?",
    multiSelect: true,
    options: [{ label: "Now", description: "Run now" }],
  },
];

/** Reads a request display item while retaining the v2 discriminated type. */
export function readFenceUserInputItem(projection: OrchestrationV2ThreadProjection) {
  const item = projection.turnItems.find((item) => item.type === "user_input_request");
  if (item?.type !== "user_input_request") throw new Error("Missing fixture question item");
  return item;
}
