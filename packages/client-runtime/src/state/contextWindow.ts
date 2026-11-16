import {
  resolveIdleCompaction,
  type ModelSelection,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
  COMPACTION_SUGGESTION_MIN_TOKENS,
  isClaudeResumeCompactionQuestion,
} from "@t3tools/shared/claudeCompaction";

import {
  deriveLatestContextWindowSnapshot,
  latestProviderTurnTokenUsage,
} from "../contextWindow/contextWindowSnapshot.ts";
import { resolvePendingHandoff } from "../handoff.ts";
import type { ThreadStructure, ThreadStructureTurnItem } from "./models.ts";

// Fallback TTL: Claude's 1h cache plus slack.
const CLAUDE_RESUME_COMPACTION_FALLBACK_MS = 70 * 60_000;

// A typed `/compact`, with or without instructions, is already the compaction. Queueing a
// bare one ahead of it would run an uninstructed compaction first and charge for two.
export const COMPACT_COMMAND_PATTERN = /^\/compact(?:\s|$)/i;

export {
  latestProviderTurnTokenUsage,
  deriveLatestContextWindowSnapshot,
} from "../contextWindow/contextWindowSnapshot.ts";
export type { ContextWindowSnapshot } from "../contextWindow/contextWindowSnapshot.ts";

export function hasDismissedResumeCompaction(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
): boolean {
  return activities.some((activity) => {
    if (activity.kind !== "user-input.resolved") return false;
    const payload = activity.payload;
    if (!payload || typeof payload !== "object") return false;
    const answers = (payload as { readonly answers?: unknown }).answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) return false;

    return Object.entries(answers).some(
      ([question, answer]) =>
        isClaudeResumeCompactionQuestion(question) &&
        answer === CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
    );
  });
}

export function shouldOfferResumeCompaction(input: {
  readonly provider: string | null | undefined;
  readonly usedTokens: number | null | undefined;
  readonly updatedAt: string | null | undefined;
  readonly promptCacheTtlMs?: number | undefined;
  readonly now: string;
}): boolean {
  if (
    input.provider !== "claudeAgent" ||
    (input.usedTokens ?? 0) < COMPACTION_SUGGESTION_MIN_TOKENS
  ) {
    return false;
  }

  const updatedAt = Date.parse(input.updatedAt ?? "");
  const now = Date.parse(input.now);
  return (
    Number.isFinite(updatedAt) &&
    Number.isFinite(now) &&
    now - updatedAt >= (input.promptCacheTtlMs ?? CLAUDE_RESUME_COMPACTION_FALLBACK_MS)
  );
}

/**
 * The tokens a plain send into an idle thread compacts first, as web's composer does under
 * "When you return", or null when it sends as is. Web reads the same state for its "Compact and
 * send" button. A send that hands off to another conversation starts that one fresh, so only the
 * resumed one counts.
 */
export function compactBeforeSendTokens(input: {
  readonly projection: Pick<
    ThreadStructure,
    | "thread"
    | "contextTransfers"
    | "providerThreads"
    | "providerTurns"
    | "runtimeRequests"
    | "runs"
    | "visibleTurnItems"
  >;
  readonly visibleTurnItems: ReadonlyArray<{ readonly item: ThreadStructureTurnItem }>;
  readonly selection: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: Pick<
    ServerSettings,
    "providerInstances" | "compactIdleThreads" | "idleCompaction" | "idleCompactionEnabled"
  >;
  readonly text: string;
  readonly threadIdle: boolean;
  readonly now: string;
}): number | null {
  const { projection } = input;
  const provider = input.providers.find((entry) => entry.instanceId === input.selection.instanceId);
  if (
    provider === undefined ||
    !input.threadIdle ||
    COMPACT_COMMAND_PATTERN.test(input.text) ||
    resolveIdleCompaction(input.settings, provider.instanceId) === "off" ||
    !provider.slashCommands.some((command) => command.name === "compact") ||
    resolvePendingHandoff(projection, input.selection, input.providers) !== null ||
    projection.runtimeRequests.some((request) => request.status === "pending") ||
    projection.runs.some((run) => run.status === "queued" && run.queueHeld === true) ||
    (!input.visibleTurnItems.some(
      ({ item }) =>
        item.type === "user_message" &&
        (item.text.trim().toLowerCase() !== "/compact" || item.attachments.length > 0),
    ) &&
      !projection.runs.some(
        (run) =>
          run.status !== "rolled_back" &&
          run.startedAt !== null &&
          !input.visibleTurnItems.some(
            ({ item }) => item.type === "user_message" && item.runId === run.id,
          ),
      )) ||
    hasDismissedResumeCompaction(
      projection.runtimeRequests
        .filter((request) => request.kind === "user_input" && request.status === "resolved")
        .map((request) => ({ kind: "user-input.resolved", payload: { answers: request.answers } })),
    )
  ) {
    return null;
  }
  const activeProviderThreadId = projection.thread.activeProviderThreadId;
  const providerThread = projection.providerThreads.find(
    (thread) => thread.id === activeProviderThreadId,
  );
  const liveUsage = latestProviderTurnTokenUsage(
    projection.providerTurns.filter((turn) => turn.providerThreadId === activeProviderThreadId),
    input.selection.instanceId === projection.thread.modelSelection.instanceId ? projection : null,
    providerThread,
  );
  const contextWindow = deriveLatestContextWindowSnapshot(
    input.visibleTurnItems,
    liveUsage,
    providerThread,
  );
  return contextWindow !== null &&
    shouldOfferResumeCompaction({
      provider: provider.driver,
      usedTokens: contextWindow.usedTokens,
      updatedAt: contextWindow.updatedAt,
      promptCacheTtlMs: liveUsage?.promptCacheTtlMs,
      now: input.now,
    })
    ? contextWindow.usedTokens
    : null;
}
