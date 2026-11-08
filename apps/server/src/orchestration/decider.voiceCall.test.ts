// Phase 2 fence: voice history in the pure orchestration core. Entry points are
// `decideOrchestrationCommand` (thread invariants for voice commands) and the pure
// `projectEvent` read model (voice events never become messages, work or latestTurn changes).
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-11-08T10:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-voice-decider");
const THREAD_ID = ThreadId.make("thread-voice-decider");
const CALL_ID = "voice-call-decider-0001";
const FRAGMENTS = [
  {
    fragmentId: "fragment-1",
    sequence: 1,
    speaker: "user",
    text: " ¿Corrés los tests?",
    startOffsetMs: 0,
    endOffsetMs: 900,
  },
  { fragmentId: "fragment-2", sequence: 2, speaker: "assistant", text: "Sí, los corro ahora." },
] as const;

const baseEvent = (sequence: number) => ({
  sequence,
  eventId: EventId.make(`event-voice-decider-${sequence}`),
  occurredAt: NOW,
  commandId: CommandId.make(`command-voice-decider-${sequence}`),
  causationEventId: null,
  correlationId: null,
  metadata: {},
});

const seedReadModel = Effect.gen(function* () {
  const withProject = yield* projectEvent(createEmptyReadModel(NOW), {
    ...baseEvent(1),
    aggregateKind: "project",
    aggregateId: PROJECT_ID,
    type: "project.created",
    payload: {
      projectId: PROJECT_ID,
      title: "Voice project",
      workspaceRoot: "/tmp/voice-project",
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  } as OrchestrationEvent);
  return yield* projectEvent(withProject, {
    ...baseEvent(2),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.created",
    payload: {
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Voice thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  } as OrchestrationEvent);
});

// The voice command shapes do not exist before phase 2, so the fence builds them untyped.
const voiceCommands = (threadId: ThreadId) =>
  [
    {
      type: "thread.voice-call.start",
      commandId: CommandId.make("command-voice-start"),
      threadId,
      callId: CALL_ID,
      ownerKey: "owner-key-a",
      startedAt: NOW,
    },
    {
      type: "thread.voice-transcript.append",
      commandId: CommandId.make("command-voice-append"),
      threadId,
      callId: CALL_ID,
      batchId: "batch-1",
      fragments: FRAGMENTS,
      appendedAt: NOW,
    },
    {
      type: "thread.voice-call.end",
      commandId: CommandId.make("command-voice-end"),
      threadId,
      callId: CALL_ID,
      reason: "hangup",
      lastSequence: 2,
      endedAt: NOW,
    },
  ] as unknown as ReadonlyArray<OrchestrationCommand>;

const decideAll = (command: OrchestrationCommand, readModel: OrchestrationReadModel) =>
  decideOrchestrationCommand({ command, readModel }).pipe(
    Effect.map((decided) => (Array.isArray(decided) ? decided : [decided])),
  );

const threadWorkState = (readModel: OrchestrationReadModel) => {
  const thread = readModel.threads.find((candidate) => candidate.id === THREAD_ID);
  return {
    messages: thread?.messages,
    latestTurn: thread?.latestTurn,
    activities: thread?.activities,
    session: thread?.session,
    proposedPlans: thread?.proposedPlans,
    checkpoints: thread?.checkpoints,
    deletedAt: thread?.deletedAt,
  };
};

it.layer(NodeServices.layer)("voice history decider phase 2 fence", (it) => {
  it.effect("VH-D1 decides each voice command into exactly its own thread event", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const expectedTypes = [
        "thread.voice-call-started",
        "thread.voice-transcript-appended",
        "thread.voice-call-ended",
      ];
      for (const [index, command] of voiceCommands(THREAD_ID).entries()) {
        const events = yield* decideAll(command, readModel);
        expect(events.map((event) => event.type)).toEqual([expectedTypes[index]]);
        expect(events[0]?.aggregateKind).toBe("thread");
        expect(events[0]?.aggregateId).toBe(THREAD_ID);
        expect(events[0]?.commandId).toBe(command.commandId);
      }
      const [appended] = yield* decideAll(voiceCommands(THREAD_ID)[1]!, readModel);
      const appendedPayload = appended?.payload as { readonly fragments?: unknown } | undefined;
      expect(appendedPayload?.fragments).toEqual(FRAGMENTS);
    }),
  );

  it.effect("VH-D2 rejects voice commands for a missing or deleted thread", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      for (const command of voiceCommands(ThreadId.make("thread-voice-missing"))) {
        const error = yield* Effect.flip(decideAll(command, readModel));
        expect(error.message).toContain("thread-voice-missing");
      }
      const deleted = yield* projectEvent(readModel, {
        ...baseEvent(3),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        type: "thread.deleted",
        payload: { threadId: THREAD_ID, deletedAt: NOW },
      } as OrchestrationEvent);
      for (const command of voiceCommands(THREAD_ID)) {
        const error = yield* Effect.flip(decideAll(command, deleted));
        expect(error.message).toContain(THREAD_ID);
      }
    }),
  );

  it.effect("VH-D3 projects voice events without changing messages, work or the latest turn", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      let projected = readModel;
      let sequence = readModel.snapshotSequence;
      for (const command of voiceCommands(THREAD_ID)) {
        for (const planned of yield* decideAll(command, projected)) {
          sequence += 1;
          projected = yield* projectEvent(projected, {
            ...planned,
            sequence,
          } as OrchestrationEvent);
        }
      }
      expect(projected.snapshotSequence).toBe(readModel.snapshotSequence + 3);
      expect(threadWorkState(projected)).toEqual(threadWorkState(readModel));
      // @effect-diagnostics-next-line preferSchemaOverJson:off - searches the whole read model as text.
      expect(JSON.stringify(projected)).not.toContain("¿Corrés los tests?");
    }),
  );

  it.effect("VH-P1 the pure projector validates voice event payloads", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const malformed = {
        ...baseEvent(3),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        type: "thread.voice-transcript-appended",
        payload: { threadId: THREAD_ID, callId: CALL_ID, fragments: [{ speaker: "tool" }] },
      } as unknown as OrchestrationEvent;
      const error = yield* Effect.flip(projectEvent(readModel, malformed));
      expect(error._tag).toBe("OrchestrationProjectorDecodeError");
    }),
  );
});
