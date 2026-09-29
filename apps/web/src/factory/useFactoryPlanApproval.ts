import {
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
import { useCallback, useMemo, useRef, useState } from "react";

import { newCommandId, newMessageId } from "../lib/utils";
import { readThread, useThread } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { buildDirectedTurnStartInput } from "../symmetria/directedComposerSubmission";

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];

/**
 * A plan card's approval: where the plan stands in this thread, the provider
 * lists its route picker offers, and Approve, which sends one user turn with
 * the thread's current model and runtime mode.
 */
export function useFactoryPlanApproval(
  threadRef: ScopedThreadRef,
  plan: FactoryPlanActivityPayload,
) {
  const thread = useThread(threadRef);
  const messages = thread?.messages;
  const approvals = useMemo(() => findPlanApprovals(messages ?? []), [messages]);
  // The thread changes with every streamed token; keep the state's identity
  // until what it says changes, so the rows below do not re-render.
  const stateKey = JSON.stringify(resolvePlanApprovalState(approvals, plan));
  const state = useMemo(() => JSON.parse(stateKey) as FactoryPlanApprovalState, [stateKey]);

  const { environments } = useEnvironments();
  const providers =
    environments.find((environment) => environment.environmentId === threadRef.environmentId)
      ?.serverConfig?.providers ?? EMPTY_PROVIDERS;

  const startTurn = useAtomCommand(threadEnvironment.startTurn);
  // The digest a sent or sending approval names: Approve stays disabled until
  // the message comes back as an approval, and a failed send clears it.
  const [sentDigest, setSentDigest] = useState<string | null>(null);
  const inFlight = useRef(false);
  const approve = useCallback(
    async (routes: FactoryRoutes) => {
      const current = readThread(threadRef);
      if (current === null || inFlight.current) return;
      inFlight.current = true;
      setSentDigest(plan.digest);
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
      inFlight.current = false;
      if (result._tag !== "Success") setSentDigest(null);
    },
    [plan.digest, plan.intentPath, plan.planPath, startTurn, threadRef],
  );

  return { state, providers, approve, sending: sentDigest === plan.digest };
}
