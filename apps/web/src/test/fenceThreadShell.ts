import {
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  ProviderInstanceId,
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
