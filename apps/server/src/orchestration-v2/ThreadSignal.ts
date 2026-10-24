/**
 * Mesura: the agent's needs-input / ready-to-close mark on a thread, and every rule that clears it.
 * The orchestrator and the event sink only call into this module.
 */
import {
  EventId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type RunId,
  type ThreadAgentSignal,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { applyToProjection, emptyProjection } from "./ProjectionStore.ts";

export type ThreadAgentSignalCommand = Extract<
  OrchestrationV2Command,
  { readonly type: "thread.agent-signal.set" | "thread.agent-signal.clear" }
>;

/**
 * The thread after the command, or a rejection cause. Clearing an absent signal returns the thread
 * unchanged rather than nothing: like an unsnooze of an awake thread, the command still emits its
 * event, because the orchestrator rejects a command that produces no events.
 */
export function decideAgentSignalCommand(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly command: ThreadAgentSignalCommand;
  readonly activeRunId: RunId | null;
  readonly now: DateTime.Utc;
}): Result.Result<OrchestrationV2AppThread, string> {
  const { thread, command } = input;
  if (thread.deletedAt !== null) return Result.fail(`Thread ${thread.id} is deleted.`);
  if (command.type === "thread.agent-signal.clear") {
    return Result.succeed(thread.agentSignal == null ? thread : { ...thread, agentSignal: null });
  }
  if (thread.archivedAt !== null) return Result.fail(`Thread ${thread.id} is archived.`);
  const note = command.note?.trim() || null;
  return Result.succeed({
    ...thread,
    agentSignal: {
      kind: command.kind,
      note,
      runId: input.activeRunId,
      setAt: DateTime.formatIso(input.now),
    },
  });
}

/** An open question for the user blocks auto-settle and ends a snooze early. */
export function agentSignalNeedsInput(thread: {
  readonly agentSignal?: ThreadAgentSignal | null | undefined;
}): boolean {
  return thread.agentSignal?.kind === "needs_input";
}

const RUN_START_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "starting",
  "running",
]);
const RUN_UNFINISHED_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "failed",
  "interrupted",
  "cancelled",
]);

/**
 * Whether `event` resolves `signal`:
 * - a message the user wrote answers or redirects whatever the agent declared;
 * - a new run means the work continues, so the thread is no longer ready to close;
 * - a run that failed or was interrupted takes back the `ready_to_close` it set.
 *
 * Automatic wakes and other agents' messages start runs but are not user-authored, so they
 * never clear `needs_input`: the user has not answered yet.
 */
export function agentSignalClearedBy(
  signal: ThreadAgentSignal,
  event: OrchestrationV2DomainEvent,
): boolean {
  switch (event.type) {
    case "message.updated":
      return event.payload.role === "user" && event.payload.createdBy === "user";
    case "run.created":
    case "run.updated": {
      if (signal.kind !== "ready_to_close") return false;
      const run = event.payload;
      if (run.id === signal.runId) return RUN_UNFINISHED_STATUSES.has(run.status);
      return RUN_START_STATUSES.has(run.status);
    }
    default:
      return false;
  }
}

/**
 * Whether `event` could clear some signal, decided without reading the thread: streamed assistant
 * messages and routine run updates must not cost a thread read on the write path.
 */
function mayClearAgentSignal(event: OrchestrationV2DomainEvent): boolean {
  switch (event.type) {
    case "message.updated":
      return event.payload.role === "user" && event.payload.createdBy === "user";
    case "run.created":
    case "run.updated":
      return (
        RUN_START_STATUSES.has(event.payload.status) ||
        RUN_UNFINISHED_STATUSES.has(event.payload.status)
      );
    default:
      return false;
  }
}

/**
 * Follows each event that clears a thread's signal with a `thread.agent-signal-cleared` event in
 * the same batch. Every writer commits through the event sink, so this one place sees every run
 * start, run failure and interrupt, whichever service wrote it; the cleared state is in the event
 * log, so replays and clients agree with the projection.
 *
 * The clearing event carries the whole thread, so its payload must be the thread as the batch
 * leaves it at that point. Each affected thread is therefore folded through the projection's own
 * reducer: a copy of the stored row would undo earlier events in the batch, such as a new
 * provider binding or the activity time.
 */
export const withAgentSignalClearings = Effect.fnUntraced(function* <E>(
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
  readThread: (threadId: ThreadId) => Effect.Effect<OrchestrationV2AppThread | null, E>,
) {
  const affected = new Set(events.filter(mayClearAgentSignal).map((event) => event.threadId));
  if (affected.size === 0) return events;
  const projections = new Map<ThreadId, OrchestrationV2ThreadProjection | null>();
  const output: Array<OrchestrationV2DomainEvent> = [];
  for (const event of events) {
    output.push(event);
    if (!affected.has(event.threadId)) continue;
    if (event.type === "thread.created") {
      projections.set(event.threadId, emptyProjection(event));
      continue;
    }
    // Read the stored row at the thread's first event in the batch, and only then: a thread the
    // batch creates has no row yet, and this read runs inside the writer's transaction.
    if (!projections.has(event.threadId)) {
      const stored = yield* readThread(event.threadId);
      projections.set(event.threadId, stored === null ? null : threadOnlyProjection(stored));
    }
    const before = projections.get(event.threadId) ?? null;
    const projection = before === null ? null : applyToProjection(before, event);
    projections.set(event.threadId, projection);
    const signal = projection?.thread.agentSignal;
    if (projection == null || signal == null || !mayClearAgentSignal(event)) continue;
    if (!agentSignalClearedBy(signal, event)) continue;
    const clearing: OrchestrationV2DomainEvent = {
      id: EventId.make(`${event.id}:agent-signal-cleared`),
      type: "thread.agent-signal-cleared",
      threadId: event.threadId,
      providerInstanceId: projection.thread.providerInstanceId,
      occurredAt: event.occurredAt,
      payload: { ...projection.thread, agentSignal: null },
    };
    output.push(clearing);
    projections.set(event.threadId, applyToProjection(projection, clearing));
  }
  return output;
});

/** The reducer only needs the thread record here; the other records start empty. */
function threadOnlyProjection(thread: OrchestrationV2AppThread): OrchestrationV2ThreadProjection {
  return emptyProjection({
    id: EventId.make(`${thread.id}:agent-signal-fold`),
    type: "thread.created",
    threadId: thread.id,
    occurredAt: thread.updatedAt,
    payload: thread,
  });
}
