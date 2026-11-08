// Entry point: voiceConversationSnapshotFromThread, which ThreadVoicePanel feeds to the call on
// every v2 projection change. These tests drive the real controller through that adapter.
import * as DateTime from "effect/DateTime";
import { NodeId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { LiveVoiceEvent } from "./protocol.ts";
import { createVoiceConversation, type VoiceAgentRequest } from "./conversation.ts";
import {
  voiceConversationSnapshotFromThread,
  type VoiceThreadProjection,
} from "./threadSnapshot.ts";

type Run = VoiceThreadProjection["runs"][number];
type Message = VoiceThreadProjection["messages"][number];

const STARTED_AT = DateTime.makeUnsafe("2026-11-08T12:00:00.000Z");

const run = (
  id: string,
  ordinal: number,
  userMessageId: string,
  status: Run["status"],
  extra: Partial<Run> = {},
): Run =>
  ({
    id,
    ordinal,
    userMessageId,
    rootNodeId: `${id}-root`,
    status,
    startedAt: status === "queued" ? null : STARTED_AT,
    ...extra,
  }) as Run;

const message = (
  id: string,
  role: Message["role"],
  runId: string | null,
  text: string,
  extra: Partial<Message> = {},
): Message =>
  ({
    id,
    role,
    runId,
    nodeId: runId === null ? null : `${runId}-root`,
    text,
    streaming: false,
    ...extra,
  }) as Message;

const transcript = (delta: string, start_ms: number, end_ms: number): LiveVoiceEvent => ({
  type: "session.input_transcript.delta",
  delta,
  start_ms,
  end_ms,
});

const delegation = (id: string, offset_ms: number): LiveVoiceEvent => ({
  type: "session.delegation.created",
  offset_ms,
  delegation: { id, target: "client" },
});

const makeHarness = () => {
  const sent: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const statuses: string[] = [];
  const requests: VoiceAgentRequest[] = [];
  let id = 0;
  const conversation = createVoiceConversation({
    mode: "discuss",
    send: (event) => sent.push(event),
    dispatch: async (request) => {
      requests.push(request);
    },
    onStatus: (status) => statuses.push(status),
    onError: (error) => errors.push(error),
    makeId: () => `generated-${++id}`,
  });
  let pending = { hasPendingApprovals: false, hasPendingUserInput: false };
  /** What ThreadVoicePanel does on a projection change: adapt, following the request in flight. */
  const project = (
    projection: Omit<VoiceThreadProjection, "nodes"> & {
      readonly nodes?: VoiceThreadProjection["nodes"];
    },
    flags: Partial<typeof pending> = {},
  ): void => {
    pending = { ...pending, ...flags };
    conversation.update(
      voiceConversationSnapshotFromThread({
        projection: { nodes: [], ...projection },
        ownedMessageId: conversation.activeMessageId,
        ...pending,
      }),
    );
  };
  const ask = async (text: string, delegationId: string, at: number) => {
    conversation.event(transcript(text, at, at + 101));
    conversation.event(delegation(delegationId, at + 100));
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    await Promise.resolve();
  };
  const spoken = () =>
    sent
      .filter((event) => event.type === "session.commentary.append")
      .map((event) => event.content);
  return { conversation, errors, statuses, requests, project, ask, spoken };
};

describe("voice snapshot from the v2 thread projection", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("voice request returns its own run's answer, not the predecessor's", async () => {
    const harness = makeHarness();
    const earlier = {
      runs: [run("run-1", 1, "typed-1", "completed")],
      messages: [
        message("typed-1", "user", "run-1", "Earlier typed task."),
        message("answer-1", "assistant", "run-1", "Earlier answer."),
      ],
    };
    harness.project(earlier);
    await harness.ask("Summarize the diff.", "voice-1", 0);
    const request = harness.requests[0]!;

    // Accepted, but the server has not created its run yet: the completed predecessor is latest.
    harness.project(earlier);
    expect(harness.spoken()).not.toContain("Earlier answer.");

    harness.project({
      runs: [...earlier.runs, run("run-2", 2, request.messageId, "running")],
      messages: [...earlier.messages, message(request.messageId, "user", "run-2", request.text)],
    });
    harness.project({
      runs: [...earlier.runs, run("run-2", 2, request.messageId, "completed")],
      messages: [
        ...earlier.messages,
        message(request.messageId, "user", "run-2", request.text),
        message("answer-2", "assistant", "run-2", "The diff renames one file."),
      ],
    });

    expect(harness.spoken()).toContain("The diff renames one file.");
    expect(harness.spoken()).not.toContain("Earlier answer.");
    expect(harness.errors).toEqual([]);
    expect(harness.requests).toHaveLength(1);
  });

  it("voice request keeps its answer when a queued typed follow-up starts in the same update", async () => {
    const harness = makeHarness();
    harness.project({ runs: [], messages: [] });
    await harness.ask("Run the tests.", "voice-1", 0);
    const request = harness.requests[0]!;
    harness.project({
      runs: [run("run-1", 1, request.messageId, "running"), run("run-2", 2, "typed-2", "queued")],
      messages: [message(request.messageId, "user", "run-1", request.text)],
    });
    // One projection delta ends the voice run and starts the queued typed run.
    harness.project({
      runs: [
        run("run-1", 1, request.messageId, "completed"),
        run("run-2", 2, "typed-2", "running"),
      ],
      messages: [
        message(request.messageId, "user", "run-1", request.text),
        message("answer-1", "assistant", "run-1", "All tests pass."),
        message("typed-2", "user", "run-2", "Typed follow-up."),
      ],
    });

    expect(harness.spoken()).toContain("All tests pass.");
    expect(harness.errors).toEqual([]);
  });

  it("voice request speaks an assistant message node under its root and excludes subagent descendants", async () => {
    const harness = makeHarness();
    harness.project({ runs: [], messages: [] });
    await harness.ask("Explain the voice transport.", "voice-message-node", 0);
    const request = harness.requests[0]!;
    harness.project({
      runs: [run("run-1", 1, request.messageId, "running")],
      messages: [message(request.messageId, "user", "run-1", request.text)],
    });
    harness.project({
      runs: [run("run-1", 1, request.messageId, "completed")],
      nodes: [
        {
          id: NodeId.make("answer-node"),
          parentNodeId: NodeId.make("run-1-root"),
          kind: "assistant_message",
        },
        {
          id: NodeId.make("child"),
          parentNodeId: NodeId.make("run-1-root"),
          kind: "subagent",
        },
        {
          id: NodeId.make("child-answer"),
          parentNodeId: NodeId.make("child"),
          kind: "assistant_message",
        },
      ],
      messages: [
        message(request.messageId, "user", "run-1", request.text),
        message("root-answer", "assistant", "run-1", "The audio uses WebRTC.", {
          nodeId: "answer-node" as Message["nodeId"],
        }),
        message("child-note", "assistant", "run-1", "Private subagent result.", {
          nodeId: "child-answer" as Message["nodeId"],
        }),
      ],
    });
    expect(harness.spoken()).toContain("The audio uses WebRTC.");
    expect(harness.spoken()).not.toContain("Private subagent result.");
    expect(harness.spoken()).not.toContain(
      "The agent finished without a spoken answer. Its work is available in the thread.",
    );
    expect(harness.errors).toEqual([]);
  });

  it("voice request reports a genuine replacement after its run was interrupted", async () => {
    const harness = makeHarness();
    harness.project({ runs: [], messages: [] });
    await harness.ask("Refactor the parser.", "voice-1", 0);
    const request = harness.requests[0]!;
    harness.project({
      runs: [run("run-1", 1, request.messageId, "running")],
      messages: [message(request.messageId, "user", "run-1", request.text)],
    });
    harness.project({
      runs: [
        run("run-1", 1, request.messageId, "interrupted"),
        run("run-2", 2, "typed-2", "running"),
      ],
      messages: [
        message(request.messageId, "user", "run-1", request.text),
        message("partial", "assistant", "run-1", "Half of a refactor."),
      ],
    });

    expect(harness.errors.at(-1)).toContain("replaced this voice request");
    expect(harness.spoken()).not.toContain("Half of a refactor.");
  });

  it("voice request waits behind a pending approval and never dispatches through it", async () => {
    const harness = makeHarness();
    harness.project(
      { runs: [run("run-1", 1, "typed-1", "waiting")], messages: [] },
      { hasPendingApprovals: true },
    );
    await harness.ask("Deploy it.", "voice-1", 0);
    expect(harness.requests).toEqual([]);
    expect(harness.statuses).toContain("Approval needed in thread");

    harness.project(
      { runs: [run("run-1", 1, "typed-1", "completed")], messages: [] },
      { hasPendingApprovals: false },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.requests).toHaveLength(1);
  });

  it("voice follow-up waits for unheld queued runs but not for a held queue", () => {
    const queued = voiceConversationSnapshotFromThread({
      projection: { nodes: [], runs: [run("run-1", 1, "typed-1", "queued")], messages: [] },
      ownedMessageId: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
    });
    expect(queued.session?.status).toBe("running");
    const held = voiceConversationSnapshotFromThread({
      projection: {
        nodes: [],
        runs: [run("run-1", 1, "typed-1", "queued", { queueHeld: true })],
        messages: [],
      },
      ownedMessageId: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
    });
    expect(held.session?.status).toBe("idle");
    expect(held.latestTurn).toBeNull();
  });

  it("voice request reports a run that failed before it started as a start failure", async () => {
    const harness = makeHarness();
    harness.project({ runs: [], messages: [] });
    await harness.ask("Check the build.", "voice-1", 0);
    const request = harness.requests[0]!;
    harness.project({
      runs: [run("run-1", 1, request.messageId, "failed", { startedAt: null })],
      messages: [message(request.messageId, "user", "run-1", request.text)],
    });
    expect(harness.spoken()).toContainEqual(
      expect.stringContaining("could not start this request"),
    );
  });

  it("voice snapshot speaks the root agent's answer, not subagent output", () => {
    const snapshot = voiceConversationSnapshotFromThread({
      projection: {
        nodes: [],
        runs: [run("run-1", 1, "typed-1", "completed")],
        messages: [
          message("root-answer", "assistant", "run-1", "Root answer."),
          message("child-note", "assistant", "run-1", "Subagent note.", {
            nodeId: "child" as Message["nodeId"],
          }),
        ] as VoiceThreadProjection["messages"],
      },
      ownedMessageId: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
    });
    expect(snapshot.messages.map((entry) => entry.id)).toEqual(["root-answer"]);
    expect(snapshot.latestTurn?.assistantMessageId).toBe("root-answer");
  });
});
