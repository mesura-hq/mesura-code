import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type EnvironmentId,
  type FactoryPlanActivityPayload,
  type OrchestrationThreadShell,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  findPlanApprovals,
  formatPlanApprovalMessage,
  type FactoryPlanApproval,
} from "@t3tools/client-runtime/factory/plan-approval";
import type { FactoryRoutes } from "@t3tools/client-runtime/factory/routes";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { makeQueuedMessageMetadata } from "../../lib/commandMetadata";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { enqueueThreadOutboxMessage, type QueuedThreadMessage } from "../../state/thread-outbox";

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];

/** What every plan card in a thread's feed needs to show its routes and approve. */
export interface FactoryPlanApprovalContext {
  readonly providers: ReadonlyArray<ServerProvider>;
  /** Approvals in the thread and in its outbox, so a queued Approve already counts. */
  readonly approvals: ReadonlyArray<FactoryPlanApproval>;
  /** Queues the Approve message; false when the outbox could not take it. */
  readonly approve: (plan: FactoryPlanActivityPayload, routes: FactoryRoutes) => Promise<boolean>;
}

/**
 * The feed's plan cards read this once per thread. Its identity changes only
 * when the approvals or the provider lists do, so a streamed token does not
 * re-render every feed row.
 */
export function useFactoryPlanApprovalContext(input: {
  readonly environmentId: EnvironmentId;
  readonly thread: OrchestrationThreadShell;
  readonly feed: ReadonlyArray<ThreadFeedEntry>;
  readonly queuedMessages: ReadonlyArray<QueuedThreadMessage>;
  readonly serverConfig: ServerConfig | null;
}): FactoryPlanApprovalContext {
  const { feed, queuedMessages } = input;
  const approvalsKey = useMemo(() => {
    const messages: Array<{ readonly role: string; readonly text: string }> = [];
    for (const entry of feed) {
      if (entry.type === "message") messages.push(entry.message);
    }
    for (const queued of queuedMessages) messages.push({ role: "user", text: queued.text });
    return JSON.stringify(findPlanApprovals(messages));
  }, [feed, queuedMessages]);
  const approvals = useMemo(
    () => JSON.parse(approvalsKey) as ReadonlyArray<FactoryPlanApproval>,
    [approvalsKey],
  );
  const providers = input.serverConfig?.providers ?? EMPTY_PROVIDERS;

  // Read at send time: the shell changes with every turn, and Approve must
  // not change identity with it.
  const latest = useRef({ environmentId: input.environmentId, thread: input.thread });
  useEffect(() => {
    latest.current = { environmentId: input.environmentId, thread: input.thread };
  }, [input.environmentId, input.thread]);
  const approve = useCallback(async (plan: FactoryPlanActivityPayload, routes: FactoryRoutes) => {
    const { environmentId, thread } = latest.current;
    const metadata = makeQueuedMessageMetadata();
    try {
      await enqueueThreadOutboxMessage({
        environmentId,
        threadId: thread.id,
        messageId: MessageId.make(metadata.messageId),
        commandId: CommandId.make(metadata.commandId),
        text: formatPlanApprovalMessage({
          digest: plan.digest,
          planPath: plan.planPath,
          intentPath: plan.intentPath,
          routes,
        }),
        attachments: [],
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        // Approving is implementing: a thread left in plan mode would plan
        // the build instead of running it. Same choice as on the web.
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: metadata.createdAt,
      });
      return true;
    } catch {
      return false;
    }
  }, []);

  return useMemo(() => ({ providers, approvals, approve }), [providers, approvals, approve]);
}
