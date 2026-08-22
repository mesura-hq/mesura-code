import { CommandId, EventId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

it.layer(NodeServices.layer)("decider context compaction", (it) => {
  it.effect("requests compaction without emitting a user message", () =>
    Effect.gen(function* () {
      const now = "2026-08-22T00:00:00.000Z";
      const projectId = ProjectId.make("project-1");
      const threadId = ThreadId.make("thread-1");
      let readModel = createEmptyReadModel(now);
      readModel = yield* projectEvent(readModel, {
        sequence: 1,
        eventId: EventId.make("event-project"),
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("command-project"),
        causationEventId: null,
        correlationId: CommandId.make("command-project"),
        metadata: {},
        payload: {
          projectId,
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      readModel = yield* projectEvent(readModel, {
        sequence: 2,
        eventId: EventId.make("event-thread"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.make("command-thread"),
        causationEventId: null,
        correlationId: CommandId.make("command-thread"),
        metadata: {},
        payload: {
          threadId,
          projectId,
          title: "Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6-sol",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.context.compact",
          commandId: CommandId.make("command-compact"),
          threadId,
          createdAt: now,
        },
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual(["thread.context-compaction-requested"]);
    }),
  );
});
