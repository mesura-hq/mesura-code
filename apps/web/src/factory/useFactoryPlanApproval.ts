import {
  AuthOrchestrationOperateScope,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type FactoryPlanActivityPayload,
  type ScopedThreadRef,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  findPlanApprovals,
  formatPlanApprovalMessage,
  resolvePlanApprovalState,
  type FactoryPlanApprovalState,
} from "@t3tools/client-runtime/factory/plan-approval";
import type { FactoryRoutes } from "@t3tools/client-runtime/factory/routes";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import { newCommandId, newMessageId } from "../lib/utils";
import { readThreadShell, useThreadProjection } from "../state/entities";
import { useEnvironmentProviders } from "../state/environments";
import { threadEnvironment } from "../state/threads";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { buildDirectedTurnStartInput } from "../dictation/directedComposerSubmission";
import {
  beginFactoryPlanSend,
  failFactoryPlanSend,
  useFactoryPlanSending,
  useHoldFactoryPlanCardSession,
} from "./factoryPlanCardSession";

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];

/** Which plan's route edits a card reads: one plan's bytes in one thread. */
export function factoryPlanRoutesKey(threadRef: ScopedThreadRef, digest: string): string {
  return `${scopedThreadKey(threadRef)}\0${digest}`;
}

/**
 * A plan card's approval: where the plan stands in this thread, the provider
 * lists its route picker offers, and Approve, which sends one user turn with
 * the thread's current model and runtime mode.
 */
export function useFactoryPlanApproval(
  threadRef: ScopedThreadRef,
  plan: FactoryPlanActivityPayload,
) {
  const thread = useThreadProjection(threadRef);
  const messages = thread?.projection.messages;
  const approvals = (() => findPlanApprovals(messages ?? []))();
  // The thread changes with every streamed token; keep the state's identity
  // until what it says changes, so the rows below do not re-render.
  const stateKey = JSON.stringify(resolvePlanApprovalState(approvals, plan));
  const state = (() => JSON.parse(stateKey) as FactoryPlanApprovalState)();

  const providersByEnvironment = useEnvironmentProviders();
  const providers = providersByEnvironment.get(threadRef.environmentId) ?? EMPTY_PROVIDERS;

  const canApprove = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const startTurn = useAtomCommand(threadEnvironment.startTurn);
  // A sent or sending approval of these bytes: Approve stays disabled on every card of the plan
  // until the message comes back as an approval, and a failed send clears it.
  const planKey = factoryPlanRoutesKey(threadRef, plan.digest);
  useHoldFactoryPlanCardSession(planKey);
  const sending = useFactoryPlanSending(planKey);
  const approve = async (routes: FactoryRoutes) => {
    // On orchestrator v2, title, model and runtime mode live on the thread shell.
    const current = readThreadShell(threadRef);
    if (
      current === null ||
      !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope) ||
      !beginFactoryPlanSend(planKey)
    )
      return;
    const result = await startTurn({
      environmentId: threadRef.environmentId,
      input: buildDirectedTurnStartInput({
        environmentId: threadRef.environmentId,
        threadId: threadRef.threadId,
        commandId: newCommandId(),
        messageId: newMessageId(),
        createdAt: new Date().toISOString(),
        prompt: formatPlanApprovalMessage({
          digest: plan.digest,
          planPath: plan.planPath,
          intentPath: plan.intentPath,
          routes,
        }),
        modelSelection: current.modelSelection,
        titleSeed: current.title,
        runtimeMode: current.runtimeMode,
        // Approving is implementing, as the proposed plan's Implement is: a
        // thread left in plan mode would plan the build instead of running it.
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        attachments: [],
        bootstrap: undefined,
        pendingAction: { kind: "composer" },
      }),
    });
    if (result._tag !== "Success") failFactoryPlanSend(planKey);
  };

  return { state, providers, approve, canApprove, sending };
}
