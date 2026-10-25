// Mesura: a search conversation is an ordinary thread, so the ordinary thread
// deletion removes one search from the history (ADR-010) even though generic
// project deletion refuses the search project itself. Entry point:
// `planThreadDeletion`, the plan the orchestrator's `thread.delete` commits.
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProviderInstanceId,
  THREAD_SEARCH_PROJECT_ID,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { emptyProjection } from "./ProjectionStore.ts";
import { planThreadDeletion } from "./ThreadDeletion.ts";

const threadId = ThreadId.make("thread:search-conversation");
const providerInstanceId = ProviderInstanceId.make("codex");
const createdAt = DateTime.makeUnsafe("2026-10-25T00:00:00.000Z");

it.effect("search thread deletion guard: one search conversation plans an ordinary deletion", () =>
  Effect.gen(function* () {
    const projection = emptyProjection({
      id: EventId.make("event:search-conversation-created"),
      type: "thread.created",
      threadId,
      occurredAt: createdAt,
      payload: {
        id: threadId,
        createdBy: "user",
        creationSource: "web",
        projectId: THREAD_SEARCH_PROJECT_ID,
        title: "New search",
        providerInstanceId,
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4-mini" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt,
        updatedAt: createdAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
    const plan = yield* planThreadDeletion({
      command: {
        type: "thread.delete",
        commandId: CommandId.make("command:delete-search-conversation"),
        threadId,
      },
      projection,
      attachmentIds: [],
      now: DateTime.makeUnsafe("2026-10-25T01:00:00.000Z"),
      idAllocator: yield* IdAllocator.IdAllocatorV2,
    });
    const deleted = plan.events.find((event) => event.type === "thread.deleted");
    assert.isDefined(deleted);
    assert.equal(deleted?.threadId, threadId);
  }).pipe(Effect.provide(IdAllocator.layer)),
);
