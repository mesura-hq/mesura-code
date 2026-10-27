/**
 * Mesura: pushes a thread to subscribed phones when it starts needing the developer, via
 * this server's own Web Push subscriptions, not T3's relay. Every announced key stays in
 * `mesura_push_announced`: resolving a newer request can resurface an already-announced one.
 * Keys present at boot count as announced; a key held while a client is active never sends.
 */
import type {
  EnvironmentId,
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadShell,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import { turnItemUpdateCanEndBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { makeAgentAwarenessPublishWorker } from "../relay/AgentAwarenessRelay.ts";
import { forkParked } from "../serverActivation.ts";
import {
  buildPushPayload,
  isPushPhase,
  PUSH_PREFERENCE_BY_PHASE,
  type PushPhase,
} from "./pushPayload.ts";
import { ClientPresence } from "./ClientPresence.ts";
import { PushSubscriptions } from "./PushSubscriptions.ts";

export class PushDispatcher extends Context.Service<
  PushDispatcher,
  {
    /** Records every thread's current key, then follows the domain events. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Resolves once every thread handed over so far is dispatched. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/push/PushDispatcher") {}

/**
 * The events that can change a thread's awareness phase. A copy of the
 * cases where upstream's `shouldPublishAgentAwarenessEvent`
 * (`relay/AgentAwarenessRelay.ts`) returns true; it is not exported, and the
 * relay is upstream's file to change.
 */
const AWARENESS_EVENT_TYPES: ReadonlySet<OrchestrationV2DomainEvent["type"]> = new Set([
  "thread.created",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "thread.metadata-updated",
  "thread.pull-request-link-updated",
  "thread.pull-request-synced",
  "thread.settled",
  "thread.model-selection-updated",
  "thread.provider-switched",
  "run.created",
  "run.updated",
  "runtime-request.updated",
  "subagent.updated",
  "provider-thread.updated",
]);

/**
 * Secret and link cards are turn items the shell reads as pending input
 * (`secretRequestAsPendingInput` in `ProjectionStore.ts`). The relay's filter
 * passes no such item, so the dispatcher adds them.
 */
const INPUT_CARD_TURN_ITEM_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "secret_request",
  "link_request",
]);

function canChangeAwareness(event: OrchestrationV2DomainEvent): boolean {
  if (event.type === "turn-item.updated") {
    return (
      INPUT_CARD_TURN_ITEM_TYPES.has(event.payload.type) ||
      turnItemUpdateCanEndBackgroundWork(event.payload)
    );
  }
  return AWARENESS_EVENT_TYPES.has(event.type);
}

/** What a push announces: the phase, and the request or run it is about. */
function sendKeyOf(shell: OrchestrationV2ThreadShell, phase: PushPhase): string {
  switch (phase) {
    case "waiting_for_approval":
    case "waiting_for_input":
      return `${phase}:${shell.pendingRuntimeRequest?.id ?? "none"}`;
    case "failed":
    case "completed":
      return `${phase}:${shell.latestRunId ?? "none"}`;
  }
}

/**
 * Keys kept per thread. A thread rarely holds more than a few pending requests
 * at once, so older keys can only name requests long resolved.
 */
const MAX_ANNOUNCED_KEYS_PER_THREAD = 32;

/** The key only reads the phase, so seeding needs no project lookup. */
const UNTITLED_PROJECT = { title: "" };

/** Waiting after a failed event stream keeps a broken store from spinning. */
const STREAM_RETRY_DELAY = "1 second";

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const subscriptions = yield* PushSubscriptions;
  const presence = yield* ClientPresence;

  const announced = new Map<ThreadId, Set<string>>();

  /** Marks `key` announced in memory; false when it already was. */
  const markAnnounced = (threadId: ThreadId, key: string): boolean => {
    const keys = announced.get(threadId) ?? new Set<string>();
    if (keys.has(key)) return false;
    keys.add(key);
    // A Set iterates in insertion order, so the first key is the oldest.
    if (keys.size > MAX_ANNOUNCED_KEYS_PER_THREAD) keys.delete(keys.values().next().value!);
    announced.set(threadId, keys);
    return true;
  };

  const recordSend = Effect.fn("PushDispatcher.recordSend")(function* (
    threadId: ThreadId,
    key: string,
  ) {
    const sentAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO mesura_push_announced (thread_id, push_key, sent_at)
      VALUES (${threadId}, ${key}, ${sentAt})
      ON CONFLICT (thread_id, push_key) DO NOTHING
    `;
    yield* sql`
      DELETE FROM mesura_push_announced
      WHERE thread_id = ${threadId} AND rowid NOT IN (
        SELECT rowid FROM mesura_push_announced WHERE thread_id = ${threadId}
        ORDER BY rowid DESC LIMIT ${MAX_ANNOUNCED_KEYS_PER_THREAD}
      )
    `;
  });

  const forgetThread = (threadId: ThreadId) =>
    Effect.suspend(() => {
      if (!announced.delete(threadId)) return Effect.void;
      return sql`DELETE FROM mesura_push_announced WHERE thread_id = ${threadId}`.pipe(
        Effect.asVoid,
      );
    });

  const dispatchThread = Effect.fn("PushDispatcher.dispatchThread")(function* (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) {
    const shell = yield* threads.getThreadShell(threadId);
    if (shell === null) return yield* forgetThread(threadId);
    // The awareness projection still reads an archived thread as waiting.
    if (shell.archivedAt !== null || shell.historyOrigin === "v1_import") return;
    const project = yield* projects.getById(shell.projectId);
    if (Option.isNone(project)) return;
    const awareness = projectThreadAwarenessV2({
      environmentId,
      project: project.value,
      thread: shell,
    });
    if (awareness === null || !isPushPhase(awareness.phase)) return;
    const phase = awareness.phase;
    const key = sendKeyOf(shell, phase);
    if (!markAnnounced(threadId, key)) return;

    // Recorded before sending: a crash mid-send loses one push rather than
    // repeating it after the restart. Recorded while the developer is active
    // too, so a held push is dropped rather than sent when they leave.
    yield* recordSend(threadId, key);
    if (yield* presence.isAnyClientActive()) return;
    yield* subscriptions.broadcast(PUSH_PREFERENCE_BY_PHASE[phase], buildPushPayload(awareness));
  });

  /**
   * Counts every active thread's current key as announced, without sending, and returns the
   * stream cursor. It must run before `start` returns: seeding later would count a thread
   * that started waiting in between as waiting at boot, so its push would never go out.
   */
  const seed = Effect.fn("PushDispatcher.seed")(function* (environmentId: EnvironmentId) {
    const persisted = yield* sql<{ readonly thread_id: ThreadId; readonly push_key: string }>`
      SELECT thread_id, push_key FROM mesura_push_announced ORDER BY rowid
    `;
    for (const row of persisted) markAnnounced(row.thread_id, row.push_key);
    // An archived thread never pushes, so its shell is not worth reading.
    const snapshot = yield* threads.getShellSnapshot({ location: "active" });
    for (const shell of snapshot.threads) {
      const phase = projectThreadAwarenessV2({
        environmentId,
        project: UNTITLED_PROJECT,
        thread: shell,
      })?.phase;
      if (phase !== undefined && isPushPhase(phase))
        markAnnounced(shell.id, sendKeyOf(shell, phase));
    }
    return snapshot.snapshotSequence;
  });

  const worker = yield* makeAgentAwarenessPublishWorker((threadId: ThreadId) =>
    serverEnvironment.getEnvironmentId.pipe(
      Effect.flatMap((environmentId) => dispatchThread(environmentId, threadId)),
      Effect.catchCause((cause) =>
        Effect.logWarning("push dispatch failed", { threadId, cause: Cause.pretty(cause) }),
      ),
    ),
  );

  const start: PushDispatcher["Service"]["start"] = Effect.fn("PushDispatcher.start")(function* () {
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const seeded = yield* seed(environmentId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("push dispatch could not read the startup state", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(null)),
      ),
    );
    if (seeded === null) return;

    // Following from the snapshot's sequence replays whatever committed
    // between the snapshot and the subscription, so no change is missed.
    let afterSequence = seeded;
    const follow = Effect.suspend(() =>
      Stream.runForEach(threads.streamStoredEventsFrom({ afterSequence }), (stored) => {
        afterSequence = stored.sequence;
        return canChangeAwareness(stored.event)
          ? worker.enqueue(stored.event.threadId)
          : Effect.void;
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("push dispatch lost the event stream; resubscribing", {
          cause: Cause.pretty(cause),
        }),
      ),
      Effect.andThen(Effect.sleep(STREAM_RETRY_DELAY)),
      Effect.forever,
    );
    yield* forkParked(follow);
    yield* Effect.logInfo("phone push dispatch following the domain events", {
      afterSequence: seeded,
    });
  });

  return PushDispatcher.of({ start, drain: worker.drain });
});

export const layer = Layer.effect(PushDispatcher, make);
