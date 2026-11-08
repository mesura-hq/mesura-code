// Phase 2 fence guard: the shared client reducer `applyThreadDetailEvent` (web and mobile thread
// detail) must leave a thread untouched for persisted voice history events. A client without a
// call interface keeps working, and spoken captions never become messages or turn state.
import { describe, expect, it } from "vite-plus/test";

import { EventId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { OrchestrationEvent, OrchestrationThread } from "@t3tools/contracts";

import { applyThreadDetailEvent } from "./threadReducer.ts";

const THREAD_ID = ThreadId.make("thread-voice-reducer");
const AT = "2026-11-08T10:00:00.000Z";

const thread: OrchestrationThread = {
  id: THREAD_ID,
  projectId: ProjectId.make("project-voice-reducer"),
  title: "Voice reducer thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: AT,
  updatedAt: AT,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  pullRequests: [],
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

const voiceEvent = (sequence: number, type: string, payload: object) =>
  ({
    sequence,
    eventId: EventId.make(`event-voice-reducer-${sequence}`),
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    occurredAt: AT,
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type,
    payload,
  }) as unknown as OrchestrationEvent;

describe("voice history client reducer phase 2 fence", () => {
  it("VH-R1 GUARD voice call events leave thread detail unchanged", () => {
    const events = [
      voiceEvent(10, "thread.voice-call-started", {
        threadId: THREAD_ID,
        callId: "voice-call-reducer-0001",
        ownerKey: "owner-key-a",
        startedAt: AT,
      }),
      voiceEvent(11, "thread.voice-transcript-appended", {
        threadId: THREAD_ID,
        callId: "voice-call-reducer-0001",
        batchId: "batch-1",
        fragments: [{ fragmentId: "fragment-1", sequence: 1, speaker: "user", text: "Hola" }],
        appendedAt: AT,
      }),
      voiceEvent(12, "thread.voice-call-ended", {
        threadId: THREAD_ID,
        callId: "voice-call-reducer-0001",
        reason: "hangup",
        lastSequence: 1,
        endedAt: AT,
      }),
    ];
    for (const event of events) {
      expect(applyThreadDetailEvent(thread, event), event.type).toEqual({ kind: "unchanged" });
    }
  });
});
