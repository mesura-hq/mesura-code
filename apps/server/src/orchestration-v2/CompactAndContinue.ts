/**
 * Mesura: an agent queues `/compact` and then its next task on its own thread, both to run after
 * its current turn ends. The server queue stores, orders, holds and shows the pair; a failed
 * compaction holds the follow-up until the user releases the queue.
 */
import { CommandId, MessageId, RunId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const COMPACT_AND_CONTINUE_NEXT_MAX_LENGTH = 4_000;
const COMPACT_AND_CONTINUE_HANDOFF_MAX_LENGTH = 8_000;
// Each rejected attempt of one message burns one command id; past this many, give up.
const MAX_QUEUE_ATTEMPTS = 20;

export const CompactAndContinueNext = Schema.String.check(
  Schema.isMaxLength(COMPACT_AND_CONTINUE_NEXT_MAX_LENGTH),
);
export const CompactAndContinueHandoff = Schema.String.check(
  Schema.isMaxLength(COMPACT_AND_CONTINUE_HANDOFF_MAX_LENGTH),
);

export const CompactAndContinueResult = Schema.Struct({
  compactMessageId: MessageId,
  compactRunId: RunId,
  followUpMessageId: MessageId,
  followUpRunId: RunId,
  status: Schema.String,
});

const refusalMessages = {
  subagent:
    "Refused: a subagent cannot compact the thread, only the thread's own agent can call this tool.",
  archived: "Refused: this thread is archived, so nothing was queued.",
  no_active_run:
    "Refused: the thread has no active run to queue behind, so call this tool during your turn.",
  no_compaction:
    "Refused: this thread's provider does not support manual compaction, so nothing was queued.",
  empty_next: "Refused: `next` is empty, so quote the user's next request in `next`.",
} as const;

class CompactAndContinueRefusedError extends Schema.TaggedError<CompactAndContinueRefusedError>()(
  "CompactAndContinueRefusedError",
  {
    reason: Schema.Literals([
      "subagent",
      "archived",
      "no_active_run",
      "no_compaction",
      "empty_next",
    ]),
  },
) {
  override get message(): string {
    return refusalMessages[this.reason];
  }
}

class CompactAndContinueAttemptsExhaustedError extends Schema.TaggedError<CompactAndContinueAttemptsExhaustedError>()(
  "CompactAndContinueAttemptsExhaustedError",
  { messageId: MessageId },
) {
  override get message(): string {
    return `Queuing ${this.messageId} was rejected ${MAX_QUEUE_ATTEMPTS} times, so it was not queued.`;
  }
}

function compactAndContinueFollowUpText(next: string, handoff: string | undefined): string {
  const request = `This continues after the context compaction the user asked for.\n\nThe user's next request:\n${next}`;
  return handoff === undefined ? request : `${request}\n\nHandoff:\n${handoff}`;
}

export const queueCompactAndContinue = Effect.fn("CompactAndContinue.queue")(function* (input: {
  readonly threadId: ThreadId;
  readonly subagent: boolean;
  readonly next: string;
  readonly handoff?: string | undefined;
}) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const refuse = (reason: CompactAndContinueRefusedError["reason"]) =>
    Effect.fail(new CompactAndContinueRefusedError({ reason }));

  if (input.subagent) return yield* refuse("subagent");
  if (input.next.trim() === "") return yield* refuse("empty_next");
  const shell = yield* threads.getThreadShell(input.threadId);
  if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null)
    return yield* refuse("archived");
  if (shell.activeRunId === null) return yield* refuse("no_active_run");
  const target = { projectId: shell.projectId, threadId: input.threadId };
  // `/compact` runs on the live session of the thread's provider thread, found as turn start finds
  // it. The MCP caller's own `providerSessionId` is an opaque per-token id, not that session.
  const { runs, providerThreads } = yield* threads.getProjectThreadRecords(target, [
    "runs",
    "providerThreads",
  ]);
  const providerThreadId =
    runs.find((run) => run.id === shell.activeRunId)?.providerThreadId ??
    shell.activeProviderThreadId;
  const providerSessionId = providerThreads.find(
    (providerThread) => providerThread.id === providerThreadId,
  )?.providerSessionId;
  const session =
    providerSessionId == null
      ? Option.none()
      : yield* sessions.get(providerSessionId).pipe(Effect.orElseSucceed(() => Option.none()));
  if (Option.isNone(session) || session.value.compactThread === undefined)
    return yield* refuse("no_compaction");

  const handoff = input.handoff?.trim() ? input.handoff : undefined;
  // One pair per active run, keyed by deterministic message ids: a repeated call finds both
  // messages, and a retry after a rejection queues only the missing one.
  const key = `compact-and-continue:${input.threadId}:${shell.activeRunId}`;
  const readQueued = Effect.fnUntraced(function* (messageId: MessageId) {
    const records = yield* threads.getProjectThreadRecords(target, ["runs", "messages"], {
      messageIds: [messageId],
    });
    const message = records.messages.find((candidate) => candidate.id === messageId);
    const run = records.runs.find((candidate) => candidate.id === message?.runId);
    return message === undefined || run === undefined ? undefined : { message, run };
  });
  const queue = Effect.fnUntraced(function* (part: "compact" | "follow-up", text: string) {
    const messageId = MessageId.make(`${key}:${part}`);
    for (let attempt = 0; attempt < MAX_QUEUE_ATTEMPTS; attempt++) {
      const queued = yield* readQueued(messageId);
      if (queued !== undefined) return queued;
      const commandId = CommandId.make(
        attempt === 0 ? `mcp:${key}:${part}` : `mcp:${key}:${part}:attempt-${attempt}`,
      );
      // A receipt without the message is a rejected attempt: receipts and events commit together.
      if (yield* threads.hasReceipt(commandId)) continue;
      const sent = yield* threads.sendToThread({
        ...target,
        commandId,
        messageId,
        senderThreadId: input.threadId,
        text,
        attachments: [],
        mode: "queue",
        createdBy: "agent",
        creationSource: "mcp",
      });
      return { message: sent.message, run: sent.run };
    }
    return yield* new CompactAndContinueAttemptsExhaustedError({ messageId });
  });
  const compact = yield* queue("compact", "/compact");
  const followUp = yield* queue("follow-up", compactAndContinueFollowUpText(input.next, handoff));
  return {
    compactMessageId: compact.message.id,
    compactRunId: compact.run.id,
    followUpMessageId: followUp.message.id,
    followUpRunId: followUp.run.id,
    status:
      "Queued /compact and the follow-up after this turn. End your turn now with a one-line reply.",
  };
});
