import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { voiceAgentPrompt } from "@t3tools/shared/voice-conversation-prompts";
import type { LiveVoiceEvent } from "./protocol.ts";
import {
  createVoiceConversation,
  voiceResultChunks,
  type VoiceAgentRequest,
} from "./conversation.ts";

type Conversation = ReturnType<typeof createVoiceConversation>;
type ThreadSnapshot = Parameters<Conversation["update"]>[0];

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const makeSnapshot = (
  input: {
    readonly turnId?: string;
    readonly userMessageId?: string | null;
    readonly assistantMessageId?: string | null;
    readonly state?: "running" | "completed" | "interrupted" | "error";
    readonly sessionStatus?: "running" | "ready";
    readonly activeTurnId?: string | null;
    readonly hasPendingApprovals?: boolean;
    readonly hasPendingUserInput?: boolean;
    readonly activities?: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>;
    readonly messages?: ReadonlyArray<{
      readonly id: string;
      readonly role: "assistant" | "user";
      readonly text: string;
      readonly turnId: string | null;
      readonly streaming: boolean;
    }>;
  } = {},
): ThreadSnapshot =>
  ({
    latestTurn: input.turnId
      ? {
          turnId: input.turnId,
          userMessageId: input.userMessageId ?? null,
          state: input.state ?? "running",
          requestedAt: "2026-10-05T00:00:00.000Z",
          startedAt: "2026-10-05T00:00:01.000Z",
          completedAt: input.state === "running" ? null : "2026-10-05T00:01:00.000Z",
          assistantMessageId: input.assistantMessageId ?? null,
        }
      : null,
    messages: input.messages ?? [],
    session: input.sessionStatus
      ? {
          threadId: "thread-1",
          status: input.sessionStatus,
          providerName: "codex",
          runtimeMode: "default",
          activeTurnId:
            input.activeTurnId !== undefined ? input.activeTurnId : (input.turnId ?? null),
          lastError: null,
          updatedAt: "2026-10-05T00:00:00.000Z",
        }
      : null,
    activities: input.activities ?? [],
    ...(input.hasPendingApprovals === undefined
      ? {}
      : { hasPendingApprovals: input.hasPendingApprovals }),
    ...(input.hasPendingUserInput === undefined
      ? {}
      : { hasPendingUserInput: input.hasPendingUserInput }),
  }) as unknown as ThreadSnapshot;

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

const settleTranscriptAndDispatch = async () => {
  await vi.advanceTimersByTimeAsync(500);
  await Promise.resolve();
  await Promise.resolve();
};

const makeHarness = (
  dispatch: (request: VoiceAgentRequest) => Promise<void> = async () => undefined,
) => {
  const sent: Record<string, unknown>[] = [];
  const statuses: string[] = [];
  const errors: string[] = [];
  const requests: VoiceAgentRequest[] = [];
  const progress: Array<string | null> = [];
  const queueChanges: Array<ReadonlyArray<{ delegationId: string; text: string }>> = [];
  const dispatchSpy = vi.fn((request: VoiceAgentRequest) => {
    requests.push(request);
    return dispatch(request);
  });
  let id = 0;
  const conversation = createVoiceConversation({
    mode: "discuss",
    send: (event) => sent.push(event),
    dispatch: dispatchSpy,
    onStatus: (status) => statuses.push(status),
    onError: (message) => errors.push(message),
    makeId: () => `generated-${++id}`,
    onProgress: (summary) => progress.push(summary),
    onQueueChange: (requests) => queueChanges.push(requests),
  });
  return { conversation, dispatchSpy, errors, requests, sent, statuses, progress, queueChanges };
};

describe("thread voice conversation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits for a late exact-boundary fragment without leaking it into the next request", async () => {
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(transcript("Do not change", 13_400, 14_800));
    harness.conversation.event(delegation("late-boundary", 14_800));
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.dispatchSpy).not.toHaveBeenCalled();
    harness.conversation.event(transcript(" files", 14_800, 15_000));
    await settleTranscriptAndDispatch();
    expect(harness.requests[0]?.text).toBe("Do not change files");
    harness.conversation.update(
      makeSnapshot({
        turnId: "first-turn",
        userMessageId: harness.requests[0]!.messageId,
        state: "completed",
      }),
    );
    harness.conversation.event(transcript("Explain the test.", 16_000, 16_500));
    harness.conversation.event(delegation("clean-follow-up", 16_400));
    await settleTranscriptAndDispatch();
    expect(harness.requests.map((request) => request.text)).toEqual([
      "Do not change files",
      "Explain the test.",
    ]);
  });

  it("rejects a whitespace-only request without blocking the event loop or the next request", async () => {
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(transcript(" ", 0, 101));
    harness.conversation.event(delegation("blank", 100));
    expect(harness.conversation.pendingCount).toBe(0);
    expect(harness.dispatchSpy).not.toHaveBeenCalled();
    harness.conversation.event(transcript("Explain the test.", 200, 301));
    harness.conversation.event(delegation("after-blank", 300));
    await settleTranscriptAndDispatch();
    expect(harness.requests[0]?.text).toBe("Explain the test.");
  });

  it("pauses new requests and clears waiting work when the follow-up limit is exceeded", async () => {
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(transcript("Active request.", 0, 101));
    harness.conversation.event(delegation("active-before-overflow", 100));
    await settleTranscriptAndDispatch();
    const activeRequest = harness.requests[0]!;
    for (let index = 0; index < 9; index++) {
      const start = 200 + index * 200;
      harness.conversation.event(transcript(`Follow-up ${index}.`, start, start + 101));
      harness.conversation.event(delegation(`overflow-${index}`, start + 100));
    }
    expect(harness.conversation.pendingCount).toBe(0);
    expect(harness.queueChanges.at(-1)).toEqual([]);
    expect(harness.errors.at(-1)).toContain("End this call");
    harness.conversation.update(
      makeSnapshot({
        turnId: "active-result",
        userMessageId: activeRequest.messageId,
        state: "completed",
        messages: [
          {
            id: "result",
            role: "assistant",
            text: "The active task finished.",
            turnId: "active-result",
            streaming: false,
          },
        ],
      }),
    );
    harness.conversation.event(transcript("Do not send this later.", 3_000, 3_101));
    harness.conversation.event(delegation("after-overflow", 3_100));
    await vi.runAllTimersAsync();
    expect(harness.dispatchSpy).toHaveBeenCalledOnce();
    expect(harness.sent).toContainEqual(
      expect.objectContaining({ content: "The active task finished." }),
    );
    expect(harness.statuses.at(-1)).toContain("End this call");
  });

  it("bounds incomplete delegations and input bytes without dispatching a truncated request", async () => {
    for (const overflow of ["delegations", "bytes", "fragments"] as const) {
      const harness = makeHarness();
      harness.conversation.update(makeSnapshot({ hasPendingApprovals: true }));
      if (overflow === "delegations") {
        for (let index = 0; index < 9; index++)
          harness.conversation.event(delegation(`pending-${index}`, index));
      } else if (overflow === "bytes") {
        harness.conversation.event(transcript("😀".repeat(16_385), 0, 101));
      } else {
        for (let index = 0; index < 1_025; index++)
          harness.conversation.event(transcript("x", index, index + 1));
      }
      harness.conversation.event(delegation("rejected-tail", 2_000));
      harness.conversation.update(makeSnapshot());
      await vi.runAllTimersAsync();
      expect(harness.errors.at(-1)).toContain("End this call");
      expect(harness.conversation.pendingCount).toBe(0);
      expect(harness.dispatchSpy).not.toHaveBeenCalled();
      harness.conversation.close();
    }
  });

  it("counts the combined queued text against the byte limit", () => {
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot({ hasPendingApprovals: true }));
    for (let index = 0; index < 5; index++) {
      harness.conversation.event(transcript("x".repeat(16_384), index * 200, index * 200 + 101));
      harness.conversation.event(delegation(`large-${index}`, index * 200 + 100));
    }
    expect(harness.errors.at(-1)).toContain("End this call");
    expect(harness.conversation.pendingCount).toBe(0);
    expect(harness.dispatchSpy).not.toHaveBeenCalled();
  });

  it("releases the input budget after dispatch and clearing follow-ups", async () => {
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot());
    for (let index = 0; index < 10; index++) {
      harness.conversation.event(transcript("x".repeat(16_384), index * 200, index * 200 + 101));
      harness.conversation.event(delegation(`completed-${index}`, index * 200 + 100));
      await settleTranscriptAndDispatch();
      harness.conversation.update(
        makeSnapshot({
          turnId: `turn-${index}`,
          userMessageId: harness.requests[index]!.messageId,
          state: "completed",
        }),
      );
    }
    harness.conversation.update(makeSnapshot({ hasPendingApprovals: true }));
    harness.conversation.event(transcript("y".repeat(48_000), 3_000, 3_101));
    harness.conversation.event(delegation("clear-large-follow-up", 3_100));
    harness.conversation.discardQueuedRequests();
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(transcript("z".repeat(48_000), 4_000, 4_101));
    harness.conversation.event(delegation("fresh-large-follow-up", 4_100));
    await settleTranscriptAndDispatch();
    expect(harness.requests).toHaveLength(11);
    expect(harness.requests.at(-1)?.text).toBe("z".repeat(48_000));
    expect(harness.errors).toEqual([]);
  });

  it("sends a quiet acknowledgement before waiting for a delayed transcript", () => {
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(delegation("delayed-transcript", 600));

    expect(harness.sent).toContainEqual(
      expect.objectContaining({
        type: "session.thinking.append",
        delegation_id: "delayed-transcript",
        event_id: expect.any(String),
      }),
    );
    expect(harness.dispatchSpy).not.toHaveBeenCalled();
    expect(harness.sent.every((event) => event.type !== "session.commentary.append")).toBe(true);
  });

  it("acknowledges an accepted request before the agent produces public progress", async () => {
    const accepted = deferred<void>();
    const harness = makeHarness(() => accepted.promise);
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(transcript("Investigate cold outreach.", 0, 100));
    harness.conversation.event(delegation("accepted-request", 100));
    await settleTranscriptAndDispatch();
    expect(harness.sent.filter((event) => event.type === "session.commentary.append")).toEqual([]);

    accepted.resolve();
    await settleTranscriptAndDispatch();
    harness.conversation.event(delegation("accepted-request", 100));
    expect(harness.progress).toEqual([null]);
    expect(harness.sent.filter((event) => event.type === "session.commentary.append")).toEqual([
      expect.objectContaining({
        content: "Okay, I’ll get started.",
        delegation_id: "accepted-request",
      }),
    ]);
    expect(harness.dispatchSpy).toHaveBeenCalledOnce();
  });

  it("voice acknowledgement precedes the first agent response under a controlled clock", async () => {
    const accepted = deferred<void>();
    const harness = makeHarness(() => accepted.promise);
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(transcript("Revisa el transporte.", 0, 100));
    harness.conversation.event(delegation("ordered-ack", 100));
    await settleTranscriptAndDispatch();
    expect(harness.dispatchSpy).toHaveBeenCalledOnce();

    // A suspended dispatch holds the acknowledgement however long the clock runs.
    await vi.advanceTimersByTimeAsync(60_000);
    const spoken = () =>
      harness.sent
        .filter((event) => event.type === "session.commentary.append")
        .map((event) => event.content);
    expect(spoken()).toEqual([]);

    accepted.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(spoken()).toEqual(["Okay, I’ll get started."]);

    harness.conversation.update(
      makeSnapshot({
        turnId: "ordered-turn",
        userMessageId: harness.requests[0]!.messageId,
        messages: [
          {
            id: "ordered-progress",
            role: "assistant",
            text: "I am reading the transport.",
            turnId: "ordered-turn",
            streaming: false,
          },
        ],
      }),
    );
    expect(spoken()).toEqual(["Okay, I’ll get started.", "I am reading the transport."]);
  });

  it("keeps a delayed acknowledgement quiet when the agent already sent public progress", async () => {
    const accepted = deferred<void>();
    const harness = makeHarness(() => accepted.promise);
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(transcript("Inspect the transport.", 0, 100));
    harness.conversation.event(delegation("fast-progress", 100));
    await settleTranscriptAndDispatch();
    harness.conversation.update(
      makeSnapshot({
        turnId: "fast-progress-turn",
        userMessageId: harness.requests[0]!.messageId,
        messages: [
          {
            id: "first-plan",
            role: "assistant",
            text: "I will inspect the transport.",
            turnId: "fast-progress-turn",
            streaming: false,
          },
        ],
      }),
    );
    accepted.resolve();
    await settleTranscriptAndDispatch();
    expect(
      harness.sent
        .filter((event) => event.type === "session.commentary.append")
        .map((event) => event.content),
    ).toEqual(["I will inspect the transport."]);
  });

  it("reports required approval instead of promising to start after a delayed acceptance", async () => {
    const accepted = deferred<void>();
    const harness = makeHarness(() => accepted.promise);
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(transcript("Inspect the protected resource.", 0, 100));
    harness.conversation.event(delegation("approval-before-acceptance", 100));
    harness.conversation.update(makeSnapshot({ hasPendingApprovals: true }));
    accepted.resolve();
    await settleTranscriptAndDispatch();
    expect(harness.statuses.at(-1)).toBe("Approval needed in thread");
    expect(harness.sent.some((event) => event.content === "Okay, I’ll get started.")).toBe(false);
  });

  it("clears queued and incomplete follow-ups without interrupting the active request", async () => {
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(transcript("Keep the first task running.", 0, 100));
    harness.conversation.event(delegation("active-request", 100));
    await settleTranscriptAndDispatch();
    const activeRequest = harness.requests[0]!;
    harness.conversation.event(transcript("Queued request.", 200, 300));
    harness.conversation.event(delegation("queued-request", 300));
    await settleTranscriptAndDispatch();
    harness.conversation.event(delegation("incomplete-request", 900));
    expect(harness.conversation.pendingCount).toBe(2);
    expect(harness.queueChanges.at(-1)).toEqual([
      { delegationId: "queued-request", text: "Queued request." },
    ]);

    harness.conversation.discardQueuedRequests();
    expect(harness.conversation.activeMessageId).toBe(activeRequest.messageId);
    expect(harness.conversation.pendingCount).toBe(0);
    expect(harness.queueChanges.at(-1)).toEqual([]);

    harness.conversation.update(
      makeSnapshot({
        turnId: "retained-turn",
        userMessageId: activeRequest.messageId,
        state: "completed",
        messages: [
          {
            id: "retained-result",
            role: "assistant",
            text: "The first task completed.",
            turnId: "retained-turn",
            streaming: false,
          },
        ],
      }),
    );
    await vi.runAllTimersAsync();
    expect(harness.dispatchSpy).toHaveBeenCalledOnce();
    expect(harness.sent).toContainEqual(
      expect.objectContaining({
        type: "session.commentary.append",
        content: "The first task completed.",
        delegation_id: "active-request",
      }),
    );
  });

  it("speaks the owned turn's first public progress once and excludes partial or unrelated text", async () => {
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(transcript("Investigate the architecture.", 0, 100));
    harness.conversation.event(delegation("research-progress", 100));
    await settleTranscriptAndDispatch();
    const userMessageId = harness.requests[0]!.messageId;
    const running = makeSnapshot({
      turnId: "research-turn",
      userMessageId,
      state: "running",
      assistantMessageId: "public-progress",
      messages: [
        {
          id: "other-progress",
          role: "assistant",
          text: "Unrelated task.",
          turnId: "other-turn",
          streaming: false,
        },
        {
          id: "public-progress",
          role: "assistant",
          text: "I checked the repository and am verifying its current dependencies.",
          turnId: "research-turn",
          streaming: false,
        },
        {
          id: "partial-progress",
          role: "assistant",
          text: "Incomplete text",
          turnId: "research-turn",
          streaming: true,
        },
      ],
    });
    harness.conversation.update(running);
    harness.conversation.update(running);
    expect(harness.progress.filter(Boolean)).toEqual([
      "I checked the repository and am verifying its current dependencies.",
    ]);
    expect(harness.sent.some((event) => String(event.content).includes("Public progress"))).toBe(
      false,
    );
    expect(harness.sent.filter((event) => event.type === "session.commentary.append")).toEqual([
      expect.objectContaining({
        content: "Okay, I’ll get started.",
        delegation_id: "research-progress",
      }),
      expect.objectContaining({
        content: "I checked the repository and am verifying its current dependencies.",
        delegation_id: "research-progress",
      }),
    ]);

    harness.conversation.update(
      makeSnapshot({ turnId: "research-turn", userMessageId, state: "completed" }),
    );
    expect(harness.progress.at(-1)).toBeNull();
  });

  it("speaks the first complete public sentence while streaming and continues without repeating it", async () => {
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(transcript("Explain the transport.", 0, 100));
    harness.conversation.event(delegation("streamed-answer", 100));
    await settleTranscriptAndDispatch();
    const userMessageId = harness.requests[0]!.messageId;
    expect(harness.requests[0]!.text).toBe("Explain the transport.");
    const update = (text: string, state: "running" | "completed" = "running") =>
      harness.conversation.update(
        makeSnapshot({
          turnId: "streamed-turn",
          userMessageId,
          state,
          assistantMessageId: "streamed-message",
          messages: [
            {
              id: "streamed-message",
              role: "assistant",
              text,
              turnId: "streamed-turn",
              streaming: state === "running",
            },
          ],
        }),
      );
    harness.conversation.update(
      makeSnapshot({
        turnId: "streamed-turn",
        userMessageId,
        messages: [
          {
            id: "initial-plan",
            role: "assistant",
            text: "I will inspect the transport.",
            turnId: "streamed-turn",
            streaming: false,
          },
        ],
      }),
    );
    const spoken = () =>
      harness.sent
        .filter((event) => event.type === "session.commentary.append")
        .map((event) => event.content);
    update("WebRTC carries");
    expect(spoken()).toEqual(["Okay, I’ll get started.", "I will inspect the transport."]);
    update("WebRTC carries audio. The agent");
    update("WebRTC carries audio. The agent handles reasoning.");
    expect(harness.conversation.activeMessageId).toBe(userMessageId);
    expect(spoken()).toEqual([
      "Okay, I’ll get started.",
      "I will inspect the transport.",
      "WebRTC carries audio.",
    ]);
    update("WebRTC carries audio. The agent handles reasoning.", "completed");
    expect(spoken()).toEqual([
      "Okay, I’ll get started.",
      "I will inspect the transport.",
      "WebRTC carries audio.",
      "The agent handles reasoning.",
    ]);
    expect(harness.conversation.activeMessageId).toBeNull();
  });

  it("keeps frequent progress quiet and speaks only fresh, distinct milestones after the interval", () => {
    vi.setSystemTime(0);
    const harness = makeHarness();
    const report = (id: string, text: string) =>
      harness.conversation.update(
        makeSnapshot({
          turnId: "research-turn",
          state: "running",
          assistantMessageId: id,
          messages: [{ id, role: "assistant", text, turnId: "research-turn", streaming: false }],
        }),
      );
    report("plan", "I will inspect the voice code.");
    vi.setSystemTime(1_000);
    report("next-step", "I found the transport and will check its cleanup.");
    expect(harness.progress.at(-1)).toBe("I found the transport and will check its cleanup.");
    expect(harness.sent.filter((event) => event.type === "session.commentary.append")).toHaveLength(
      1,
    );

    vi.setSystemTime(15_000);
    report("repeat", "I will inspect the voice code.");
    report("milestone", "The transport releases the microphone. I will check cancellation next.");
    expect(
      harness.sent
        .filter((event) => event.type === "session.commentary.append")
        .map((event) => event.content),
    ).toEqual([
      "I will inspect the voice code.",
      "The transport releases the microphone. I will check cancellation next.",
    ]);

    vi.setSystemTime(16_000);
    report("superseded", "I will check another file.");
    harness.conversation.update(makeSnapshot({ turnId: "research-turn", state: "completed" }));
    vi.runAllTimers();
    expect(harness.sent.some((event) => event.content === "I will check another file.")).toBe(
      false,
    );
  });

  it("announces a new task without waiting for the previous task's progress interval", () => {
    const harness = makeHarness();
    for (const turnId of ["first-turn", "second-turn"]) {
      harness.conversation.update(
        makeSnapshot({
          turnId,
          state: "running",
          messages: [
            {
              id: `${turnId}-plan`,
              role: "assistant",
              text: "I will inspect the source.",
              turnId,
              streaming: false,
            },
          ],
        }),
      );
    }
    expect(harness.sent.filter((event) => event.type === "session.commentary.append")).toHaveLength(
      2,
    );
  });

  it("observes work started before the call and announces its result exactly once", () => {
    const harness = makeHarness();
    harness.conversation.update(
      makeSnapshot({
        turnId: "existing-turn",
        state: "running",
        userMessageId: "typed-request",
        messages: [
          {
            id: "existing-progress",
            role: "assistant",
            text: "I found the relevant source.",
            turnId: "existing-turn",
            streaming: false,
          },
        ],
      }),
    );
    expect(harness.progress.at(-1)).toBe("I found the relevant source.");
    const completed = makeSnapshot({
      turnId: "existing-turn",
      state: "completed",
      userMessageId: "typed-request",
      assistantMessageId: "existing-answer",
      messages: [
        {
          id: "existing-answer",
          role: "assistant",
          text: "The source confirms the result.",
          turnId: "existing-turn",
          streaming: false,
        },
      ],
    });
    harness.conversation.update(completed);
    harness.conversation.update(completed);
    expect(harness.dispatchSpy).not.toHaveBeenCalled();
    expect(harness.sent.filter((event) => event.type === "session.commentary.append")).toEqual([
      expect.objectContaining({ delegation_id: null, content: "I found the relevant source." }),
      expect.objectContaining({ delegation_id: null, content: "The source confirms the result." }),
    ]);
  });

  it("does not read a historical completed answer when the call starts", () => {
    const harness = makeHarness();
    harness.conversation.update(
      makeSnapshot({
        turnId: "historical-turn",
        state: "completed",
        assistantMessageId: "historical-answer",
        messages: [
          {
            id: "historical-answer",
            role: "assistant",
            text: "An old answer.",
            turnId: "historical-turn",
            streaming: false,
          },
        ],
      }),
    );
    expect(harness.sent).toEqual([]);
  });

  it.each([
    {
      state: "completed" as const,
      result: "Audio uses WebRTC. The provider runs the task.",
      remaining: ["The provider runs the task."],
    },
    {
      state: "completed" as const,
      result: "Audio uses a different transport. The result changed.",
      remaining: ["Audio uses a different transport. The result changed."],
    },
    {
      state: "error" as const,
      result: "Audio uses WebRTC. The provider failed before starting the task.",
      remaining: ["Audio uses WebRTC. The provider failed before starting the task."],
    },
    {
      state: "completed" as const,
      result: "Audio uses WebRTC.",
      remaining: [],
    },
  ])("prepares a background $state result faithfully: $result", ({ state, result, remaining }) => {
    const harness = makeHarness();
    const update = (text: string, currentState: "running" | typeof state) =>
      harness.conversation.update(
        makeSnapshot({
          turnId: "background-stream",
          userMessageId: "typed-request",
          assistantMessageId: "background-answer",
          state: currentState,
          messages: [
            {
              id: "background-answer",
              role: "assistant",
              text,
              turnId: "background-stream",
              streaming: currentState === "running",
            },
          ],
        }),
      );
    update("Audio uses WebRTC. The provider", "running");
    update(result, state);
    update(result, state);
    expect(
      harness.sent
        .filter((event) => event.type === "session.commentary.append")
        .map((event) => event.content),
    ).toEqual(["Audio uses WebRTC.", ...remaining]);
    expect(harness.dispatchSpy).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "pauses requests when clearing speech before delegation (timestamps: %s)",
    async (hasTimestamps) => {
      const harness = makeHarness();
      harness.conversation.update(makeSnapshot({ hasPendingApprovals: true }));
      harness.conversation.event(transcript("Queued task.", 0, 101));
      harness.conversation.event(delegation("known-queued", 100));
      harness.conversation.event(
        hasTimestamps
          ? transcript("Do not", 200, 300)
          : { type: "session.input_transcript.delta", delta: "Do not" },
      );
      harness.conversation.discardQueuedRequests();
      harness.conversation.event(transcript(" delete files.", 300, 501));
      harness.conversation.event(delegation("late-current-speech", 500));
      harness.conversation.update(makeSnapshot());
      await vi.runAllTimersAsync();

      expect(harness.requests).toEqual([]);
      expect(harness.conversation.pendingCount).toBe(0);
      expect(harness.errors.at(-1)).toContain("End this call");
      expect(harness.errors.at(-1)).not.toContain("buffer is full");
      expect(harness.statuses.at(-1)).toContain("End this call");
    },
  );

  it("preserves accepted work when clearing an utterance with no known boundary", async () => {
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(transcript("Keep working.", 0, 101));
    harness.conversation.event(delegation("accepted-before-clear", 100));
    await settleTranscriptAndDispatch();
    const accepted = harness.requests[0]!;
    harness.conversation.event(transcript("Queued task.", 200, 301));
    harness.conversation.event(delegation("queued-before-clear", 300));
    harness.conversation.event(transcript("Do not", 400, 500));
    harness.conversation.discardQueuedRequests();
    harness.conversation.event(transcript(" delete files.", 500, 701));
    harness.conversation.event(delegation("tail-after-clear", 700));
    harness.conversation.update(
      makeSnapshot({
        turnId: "accepted-turn",
        userMessageId: accepted.messageId,
        assistantMessageId: "accepted-answer",
        state: "completed",
        messages: [
          {
            id: "accepted-answer",
            role: "assistant",
            text: "The accepted task finished.",
            turnId: "accepted-turn",
            streaming: false,
          },
        ],
      }),
    );
    await vi.runAllTimersAsync();

    expect(harness.requests).toEqual([accepted]);
    expect(harness.sent).toContainEqual(
      expect.objectContaining({
        content: "The accepted task finished.",
        delegation_id: "accepted-before-clear",
      }),
    );
    expect(harness.conversation.activeMessageId).toBeNull();
    expect(harness.statuses.at(-1)).toContain("End this call");
  });

  it("rejects a late delegation within the cleared boundary before accepting fresh speech", async () => {
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot({ hasPendingApprovals: true }));
    harness.conversation.event(delegation("cleared-request", 200));
    harness.conversation.discardQueuedRequests();
    harness.conversation.event(delegation("late-cleared-request", 150));
    harness.conversation.event(transcript("Explain the test.", 250, 401));
    harness.conversation.event(delegation("fresh-after-clear", 400));
    harness.conversation.update(makeSnapshot());
    await settleTranscriptAndDispatch();

    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]?.text).toBe("Explain the test.");
    expect(harness.requests[0]?.delegationId).toBe("fresh-after-clear");
  });

  it("excludes late canceled speech and cleared context from the next agent request", async () => {
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(transcript("Keep working.", 0, 100));
    harness.conversation.event(delegation("retained-request", 100));
    await settleTranscriptAndDispatch();
    harness.conversation.event(transcript("A queued request to discard.", 110, 150));
    harness.conversation.event(delegation("queued-discarded", 150));
    harness.conversation.event(delegation("late-discarded", 200));
    harness.conversation.discardQueuedRequests();
    harness.conversation.event(transcript("Delete the branch.", 160, 200));
    harness.conversation.event(
      transcript("Late text that crosses the canceled boundary.", 190, 220),
    );
    harness.conversation.event(transcript("Only explain the test.", 250, 400));
    harness.conversation.event(delegation("new-request", 400));
    harness.conversation.update(
      makeSnapshot({
        turnId: "retained-turn",
        userMessageId: harness.requests[0]!.messageId,
        state: "completed",
      }),
    );
    await settleTranscriptAndDispatch();

    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[1]?.text).toBe("Only explain the test.");
    expect(harness.requests[1]?.text).not.toContain("Delete the branch");
    expect(harness.requests[1]?.text).not.toContain("Late text");
    expect(harness.requests[1]?.text).not.toContain("A queued request to discard");
  });

  it("rejects speech without a timestamp after clearing an incomplete request", async () => {
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(delegation("canceled-without-text", 200));
    harness.conversation.discardQueuedRequests();
    harness.conversation.event({
      type: "session.input_transcript.delta",
      delta: "Unmatched canceled command.",
    });
    harness.conversation.event(delegation("another-request", 400));
    await vi.runAllTimersAsync();
    expect(harness.dispatchSpy).not.toHaveBeenCalled();
    expect(harness.errors).toContain(
      "Speech could not be matched after clearing follow-ups. End this call and start another before repeating the request.",
    );
  });

  it("recovers a replaced request when the matching running snapshot was missed", async () => {
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(transcript("First task.", 0, 100));
    harness.conversation.event(delegation("missed-first", 100));
    await settleTranscriptAndDispatch();
    const firstRequest = harness.requests[0]!;
    harness.conversation.event(transcript("Next task.", 200, 300));
    harness.conversation.event(delegation("after-missed", 300));
    harness.conversation.update(
      makeSnapshot({
        turnId: "newer-turn",
        state: "completed",
        userMessageId: "different-request",
        messages: [
          {
            id: firstRequest.messageId,
            role: "user",
            text: firstRequest.text,
            turnId: "missed-turn",
            streaming: false,
          },
        ],
      }),
    );
    await settleTranscriptAndDispatch();
    expect(harness.errors).toContain(
      "A newer thread turn replaced this voice request before it completed.",
    );
    expect(harness.dispatchSpy).toHaveBeenCalledTimes(2);
    expect(harness.requests[1]?.delegationId).toBe("after-missed");
  });

  it("maps one client delegation to the request transcript and stable IDs", async () => {
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(transcript("Inspect this change.", 0, 500));
    harness.conversation.event(delegation("delegation-1", 500));
    await settleTranscriptAndDispatch();

    expect(harness.dispatchSpy).toHaveBeenCalledOnce();
    expect(harness.requests[0]).toMatchObject({
      delegationId: "delegation-1",
      messageId: "generated-1",
      commandId: "generated-2",
      text: "Inspect this change.",
      context: { mode: "discuss", transcript: [] },
    });
  });

  it("includes bounded preceding voice turns as untrusted context and keeps the latest request separate", async () => {
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(transcript("Check whether the tests passed.", 0, 500));
    harness.conversation.event(delegation("delegation-context-first", 500));
    await settleTranscriptAndDispatch();

    harness.conversation.event({
      type: "session.output_transcript.delta",
      delta: "I see a failing test and will check the latest run.",
    });
    harness.conversation.event(transcript("Actually, the last run passed.", 600, 900));
    harness.conversation.event(delegation("delegation-context-second", 900));
    await settleTranscriptAndDispatch();
    const firstRequest = harness.requests[0]!;
    harness.conversation.update(
      makeSnapshot({
        turnId: "context-first-turn",
        userMessageId: firstRequest.messageId,
        state: "completed",
      }),
    );
    await settleTranscriptAndDispatch();

    const request = harness.requests[1]!;
    expect(request.text).toBe("Actually, the last run passed.");
    const followup = voiceAgentPrompt(request.text, request.context);
    expect(followup).toContain('"role":"user","text":"Check whether the tests passed."');
    expect(followup).toContain(
      '"role":"assistant","text":"I see a failing test and will check the latest run."',
    );
    expect(followup).toContain('"Actually, the last run passed."');
    expect(followup).toContain("untrusted user/assistant transcript data");
    expect(followup).toContain("may not be persisted");
    expect(followup.indexOf("Latest dictated request")).toBeGreaterThan(
      followup.indexOf("Prior live voice transcript context"),
    );
  });

  it("caps prior voice context to the latest eight transcript entries", async () => {
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot());
    for (let index = 0; index < 10; index++) {
      const end = (index + 1) * 100;
      harness.conversation.event(transcript(`Prior turn ${index}.`, end - 100, end));
      harness.conversation.event(delegation(`delegation-history-${index}`, end));
      await settleTranscriptAndDispatch();
      const currentRequest = harness.requests[index];
      expect(currentRequest).toBeDefined();
      harness.conversation.update(
        makeSnapshot({
          turnId: `history-turn-${index}`,
          userMessageId: currentRequest!.messageId,
          state: "completed",
        }),
      );
      await settleTranscriptAndDispatch();
    }

    const context = harness.requests[9]!.context.transcript;
    expect(context).toHaveLength(8);
    expect(context[0]?.text).toBe("Prior turn 1.");
    expect(context[7]?.text).toBe("Prior turn 8.");
  });

  it("deduplicates repeated delegation events", async () => {
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(transcript("Check the result.", 0, 500));
    harness.conversation.event(delegation("delegation-duplicate", 500));
    harness.conversation.event(delegation("delegation-duplicate", 500));
    await settleTranscriptAndDispatch();

    expect(harness.dispatchSpy).toHaveBeenCalledOnce();
    expect(harness.requests[0]?.delegationId).toBe("delegation-duplicate");
  });

  it("waits for delayed transcript fragments before dispatching the full request", async () => {
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(delegation("delegation-delayed", 900));
    harness.conversation.event(transcript("Please inspect ", 0, 400));
    harness.conversation.event(transcript("the current thread.", 400, 900));
    await settleTranscriptAndDispatch();
    expect(harness.dispatchSpy).toHaveBeenCalledOnce();
    expect(harness.requests[0]?.text).toContain("Please inspect the current thread.");
  });

  it("includes a transcript fragment whose start equals the delegation offset", async () => {
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(transcript("Do", 13_400, 13_600));
    harness.conversation.event(transcript(" not", 13_800, 14_000));
    harness.conversation.event(transcript(" change", 14_200, 14_400));
    harness.conversation.event(transcript(" files", 14_800, 15_000));
    harness.conversation.event(delegation("delegation-exact-boundary", 14_800));
    await settleTranscriptAndDispatch();

    expect(harness.requests[0]?.text).toBe("Do not change files");
  });

  it("continues past an end exactly at the offset when the next fragment starts there", async () => {
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(transcript("Do not change", 13_400, 14_800));
    harness.conversation.event(transcript(" files", 14_800, 15_000));
    harness.conversation.event(delegation("delegation-adjacent-boundary", 14_800));
    await settleTranscriptAndDispatch();

    expect(harness.requests[0]?.text).toBe("Do not change files");
  });

  it("includes the exact-boundary fragment but excludes later speech already in the buffer", async () => {
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(transcript("Do", 13_400, 13_600));
    harness.conversation.event(transcript(" not", 13_800, 14_000));
    harness.conversation.event(transcript(" change", 14_200, 14_400));
    harness.conversation.event(transcript(" files", 14_800, 15_000));
    harness.conversation.event(transcript(" after", 15_200, 15_400));
    harness.conversation.event(delegation("delegation-later-fragment", 14_800));
    await settleTranscriptAndDispatch();

    expect(harness.requests[0]?.text).toBe("Do not change files");
    expect(harness.requests[0]?.text).not.toContain("Do not change files after");
  });

  it("uses a bounded settle fallback when transcript timestamps are absent", async () => {
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot());
    harness.conversation.event({
      type: "session.input_transcript.delta",
      delta: "Explain the result.",
    });
    harness.conversation.event(delegation("delegation-no-timestamps", 900));
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.dispatchSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    await settleTranscriptAndDispatch();
    expect(harness.requests[0]?.text).toContain("Explain the result.");
  });

  it("keeps delegated follow-ups queued while the thread is busy", async () => {
    const harness = makeHarness();
    harness.conversation.update(
      makeSnapshot({
        turnId: "existing-turn",
        userMessageId: "existing-message",
        sessionStatus: "running",
      }),
    );
    harness.conversation.event(transcript("Also explain the failing check.", 0, 700));
    harness.conversation.event(delegation("delegation-follow-up", 700));
    await settleTranscriptAndDispatch();
    expect(harness.dispatchSpy).not.toHaveBeenCalled();
    expect(harness.conversation.pendingCount).toBe(1);

    harness.conversation.update(
      makeSnapshot({
        turnId: "existing-turn",
        userMessageId: "existing-message",
        state: "completed",
        sessionStatus: "ready",
      }),
    );
    await settleTranscriptAndDispatch();
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]?.delegationId).toBe("delegation-follow-up");
  });

  it.each([
    { hasPendingApprovals: true, hasPendingUserInput: false, label: "approval" },
    { hasPendingApprovals: false, hasPendingUserInput: true, label: "user input" },
    { hasPendingApprovals: true, hasPendingUserInput: true, label: "both gates" },
  ])("blocks dispatch while $label is pending and reports each gate state once", async (flags) => {
    const harness = makeHarness();
    const snapshot = makeSnapshot(flags);
    harness.conversation.update(snapshot);
    harness.conversation.update(snapshot);
    const commentary = () =>
      harness.sent.filter((event) => event.type === "session.commentary.append");
    // Unchanged snapshots stay quiet.
    expect(harness.statuses).toHaveLength(1);
    expect(commentary()).toHaveLength(1);
    harness.conversation.event(transcript("Continue after this is resolved.", 0, 500));
    harness.conversation.event(delegation(`delegation-${flags.label}`, 500));
    await settleTranscriptAndDispatch();

    expect(harness.dispatchSpy).not.toHaveBeenCalled();
    // The new request hears the block once, on its own delegation.
    expect(commentary()).toHaveLength(2);
    expect(commentary()[1]?.delegation_id).toBe(`delegation-${flags.label}`);
    expect(harness.statuses.at(-1)).toBe(harness.statuses[0]);
    expect(harness.sent.some((event) => String(event.content).includes("Mesura Code"))).toBe(true);

    harness.conversation.update(makeSnapshot());
    await settleTranscriptAndDispatch();
    expect(harness.dispatchSpy).toHaveBeenCalledOnce();
  });

  it("ignores unrelated completed turns and only reports a matching completed result", async () => {
    const acknowledgement = deferred<void>();
    const harness = makeHarness(() => acknowledgement.promise);
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(transcript("Summarize the current work.", 0, 600));
    harness.conversation.event(delegation("delegation-correlated", 600));
    await settleTranscriptAndDispatch();
    const request = harness.requests[0]!;
    expect(harness.conversation.activeMessageId).toBe(request.messageId);

    harness.conversation.update(
      makeSnapshot({
        turnId: "unrelated-turn",
        userMessageId: "some-other-message",
        state: "completed",
        messages: [
          {
            id: "unrelated-answer",
            role: "assistant",
            text: "Unrelated result.",
            turnId: "unrelated-turn",
            streaming: false,
          },
        ],
      }),
    );
    expect(harness.sent.some((event) => event.content === "Unrelated result.")).toBe(false);
    expect(harness.conversation.activeMessageId).toBe(request.messageId);

    harness.conversation.update(
      makeSnapshot({
        turnId: "voice-turn",
        userMessageId: request.messageId,
        state: "running",
        messages: [
          {
            id: "voice-answer",
            role: "assistant",
            text: "The result is still streaming",
            turnId: "voice-turn",
            streaming: true,
          },
        ],
      }),
    );
    expect(harness.sent.some((event) => event.content === "The result is still streaming")).toBe(
      false,
    );

    harness.conversation.update(
      makeSnapshot({
        turnId: "voice-turn",
        userMessageId: request.messageId,
        state: "completed",
        messages: [
          {
            id: "voice-answer",
            role: "assistant",
            text: "The tests passed, with one skipped case.",
            turnId: "voice-turn",
            streaming: false,
          },
        ],
      }),
    );
    expect(
      harness.sent.some((event) => event.content === "The tests passed, with one skipped case."),
    ).toBe(true);
    expect(harness.conversation.activeMessageId).toBeNull();
    acknowledgement.resolve();
    await settleTranscriptAndDispatch();
    expect(
      harness.sent.filter((event) => event.content === "The tests passed, with one skipped case."),
    ).toHaveLength(1);
  });

  it("returns to listening after dispatch fails before the thread turn starts", async () => {
    const harness = makeHarness(async () => {
      throw new Error("Dispatch was rejected.");
    });
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(transcript("Check this request.", 0, 300));
    harness.conversation.event(delegation("delegation-dispatch-failed", 300));
    await settleTranscriptAndDispatch();

    expect(harness.errors).toContain("Dispatch was rejected.");
    expect(harness.sent.some((event) => event.content === "Okay, I’ll get started.")).toBe(false);
    expect(harness.conversation.activeMessageId).toBeNull();
    expect(harness.statuses.at(-1)).toBe("Listening");
  });

  it("waits for the completed turn's assistant message when detail state arrives first", async () => {
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(transcript("Summarize the checks.", 0, 500));
    harness.conversation.event(delegation("delegation-detail-order", 500));
    await settleTranscriptAndDispatch();
    const request = harness.requests[0]!;

    harness.conversation.update(
      makeSnapshot({
        turnId: "detail-order-turn",
        userMessageId: request.messageId,
        assistantMessageId: "delayed-assistant-message",
        state: "completed",
      }),
    );
    expect(harness.conversation.activeMessageId).toBe(request.messageId);
    expect(
      harness.sent.some(
        (event) =>
          event.content ===
          "The agent finished without a spoken answer. Its work is available in the thread.",
      ),
    ).toBe(false);

    harness.conversation.update(
      makeSnapshot({
        turnId: "detail-order-turn",
        userMessageId: request.messageId,
        assistantMessageId: "delayed-assistant-message",
        state: "completed",
        messages: [
          {
            id: "delayed-assistant-message",
            role: "assistant",
            text: "The checks passed.",
            turnId: null,
            streaming: true,
          },
        ],
      }),
    );
    expect(harness.conversation.activeMessageId).toBe(request.messageId);
    expect(harness.sent.some((event) => event.content === "The checks passed.")).toBe(false);

    harness.conversation.update(
      makeSnapshot({
        turnId: "detail-order-turn",
        userMessageId: request.messageId,
        assistantMessageId: "delayed-assistant-message",
        state: "completed",
        messages: [
          {
            id: "delayed-assistant-message",
            role: "assistant",
            text: "The checks passed.",
            turnId: null,
            streaming: false,
          },
        ],
      }),
    );

    expect(harness.conversation.activeMessageId).toBeNull();
    expect(harness.sent.some((event) => event.content === "The checks passed.")).toBe(true);
  });

  it("sends only the authoritative final assistant message, not turn progress messages", async () => {
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(transcript("Read the README.", 0, 300));
    harness.conversation.event(delegation("delegation-final-message", 300));
    await settleTranscriptAndDispatch();
    const request = harness.requests[0]!;

    harness.conversation.update(
      makeSnapshot({
        turnId: "long-research-turn",
        userMessageId: request.messageId,
        assistantMessageId: "final-answer",
        state: "completed",
        messages: [
          {
            id: "progress-message",
            role: "assistant",
            text: "I will read README.md and inspect the implementation.",
            turnId: "long-research-turn",
            streaming: false,
          },
          {
            id: "final-answer",
            role: "assistant",
            text: "The README says expired entries are removed on read, not by a background task.",
            turnId: "long-research-turn",
            streaming: false,
          },
        ],
      }),
    );

    expect(
      harness.sent.some(
        (event) =>
          event.content ===
          "The README says expired entries are removed on read, not by a background task.",
      ),
    ).toBe(true);
    expect(
      harness.sent.some(
        (event) => event.content === "I will read README.md and inspect the implementation.",
      ),
    ).toBe(false);
  });

  it("ignores late thread and voice events after close", async () => {
    const acknowledgement = deferred<void>();
    const harness = makeHarness(() => acknowledgement.promise);
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(transcript("Do the task.", 0, 300));
    harness.conversation.event(delegation("delegation-closed", 300));
    await settleTranscriptAndDispatch();
    const sentBeforeClose = harness.sent.length;

    harness.conversation.close();
    harness.conversation.update(
      makeSnapshot({
        turnId: "late-turn",
        userMessageId: harness.requests[0]!.messageId,
        state: "completed",
        messages: [
          {
            id: "late-answer",
            role: "assistant",
            text: "Late answer.",
            turnId: "late-turn",
            streaming: false,
          },
        ],
      }),
    );
    harness.conversation.event(transcript("Do another task.", 400, 700));
    harness.conversation.event(delegation("delegation-after-close", 700));
    acknowledgement.resolve();
    await settleTranscriptAndDispatch();

    expect(harness.sent).toHaveLength(sentBeforeClose);
    expect(harness.dispatchSpy).toHaveBeenCalledOnce();
  });

  it("releases an active request when a newer completed turn supersedes it", async () => {
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(transcript("First request.", 0, 200));
    harness.conversation.event(delegation("delegation-first", 200));
    harness.conversation.event(transcript("Second request.", 300, 600));
    harness.conversation.event(delegation("delegation-second", 600));
    await settleTranscriptAndDispatch();
    expect(harness.dispatchSpy).toHaveBeenCalledOnce();

    const firstRequest = harness.requests[0]!;
    harness.conversation.update(
      makeSnapshot({
        turnId: "first-turn",
        userMessageId: firstRequest.messageId,
        state: "running",
      }),
    );
    harness.conversation.update(
      makeSnapshot({
        turnId: "newer-turn",
        userMessageId: "external-message",
        state: "completed",
        messages: [
          {
            id: "external-answer",
            role: "assistant",
            text: "A different request completed.",
            turnId: "newer-turn",
            streaming: false,
          },
        ],
      }),
    );
    await settleTranscriptAndDispatch();

    expect(harness.sent.some((event) => event.content === "A different request completed.")).toBe(
      false,
    );
    expect(harness.conversation.activeMessageId).toBe(harness.requests[1]?.messageId);
    expect(harness.dispatchSpy).toHaveBeenCalledTimes(2);
    expect(harness.requests[1]?.delegationId).toBe("delegation-second");
  });

  it("releases a failed provider start by activity requestId and dispatches the next queued request", async () => {
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(transcript("First request.", 0, 200));
    harness.conversation.event(delegation("delegation-start-fails", 200));
    harness.conversation.event(transcript("Second request.", 300, 600));
    harness.conversation.event(delegation("delegation-after-failure", 600));
    await settleTranscriptAndDispatch();
    expect(harness.dispatchSpy).toHaveBeenCalledOnce();

    const firstRequest = harness.requests[0]!;
    harness.conversation.update(
      makeSnapshot({
        activities: [
          {
            kind: "provider.turn.start.failed",
            payload: { requestId: firstRequest.messageId, detail: "Provider unavailable." },
          },
        ],
      }),
    );
    await settleTranscriptAndDispatch();

    expect(harness.errors).toContain("Provider unavailable.");
    expect(
      harness.sent.some((event) => String(event.content).includes("could not start this request")),
    ).toBe(true);
    expect(harness.dispatchSpy).toHaveBeenCalledTimes(2);
    expect(harness.conversation.activeMessageId).toBe(harness.requests[1]?.messageId);
  });

  it("keeps result chunks below 500 UTF-8 bytes and preserves Unicode", () => {
    const text = Array.from({ length: 1_500 }, () => "canción🙂").join(" ");
    const chunks = voiceResultChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    const encoder = new TextEncoder();
    expect(chunks.every((chunk) => encoder.encode(chunk).byteLength <= 500)).toBe(true);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => !/[\uD800-\uDBFF]$/u.test(chunk))).toBe(true);
  });

  it("replaces code blocks before sending spoken result chunks", () => {
    const chunks = voiceResultChunks(
      "Summary.\n\n```ts\nconst privateDetail = true;\n```\n\nThe tests passed.",
    );
    const result = chunks.join(" ");
    expect(result).toContain("[Code is available in the thread.]");
    expect(result).not.toContain("privateDetail");
    expect(result).toContain("The tests passed.");
  });
});

// Fence for phase 1 of the realtime voice seal. Each case replays a snapshot or event
// sequence observed in a live call through the web app; the probe runs are recorded in
// /home/dev/projects/factory-runs/mesura-realtime-voice/phase-1/probes/runs/.
describe("thread voice conversation, live-observed sequences", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps the voice request when a late checkpoint moves the latest turn back to the previous turn", async () => {
    // Observed in approval-decline-during-call: the previous turn's checkpoint finished
    // 1.4 s after the voice turn started, and the thread shell reported that previous
    // turn as latestTurn while the session still ran the voice turn.
    const harness = makeHarness();
    harness.conversation.update(
      makeSnapshot({ turnId: "previous-turn", state: "running", sessionStatus: "running" }),
    );
    harness.conversation.event(transcript("Inspect the voice code.", 0, 500));
    harness.conversation.event(delegation("delegation-after-checkpoint", 500));
    await settleTranscriptAndDispatch();
    expect(harness.dispatchSpy).not.toHaveBeenCalled();

    const previousCompleted = makeSnapshot({
      turnId: "previous-turn",
      state: "completed",
      sessionStatus: "ready",
      assistantMessageId: "previous-answer",
      messages: [
        {
          id: "previous-answer",
          role: "assistant",
          text: "Previous work.",
          turnId: "previous-turn",
          streaming: false,
        },
      ],
    });
    harness.conversation.update(previousCompleted);
    await settleTranscriptAndDispatch();
    expect(harness.dispatchSpy).toHaveBeenCalledOnce();
    const request = harness.requests[0]!;

    harness.conversation.update(
      makeSnapshot({
        turnId: "voice-turn",
        userMessageId: request.messageId,
        state: "running",
        sessionStatus: "running",
      }),
    );
    // The late checkpoint: latestTurn regresses while the session keeps running the voice turn.
    harness.conversation.update(
      makeSnapshot({
        turnId: "previous-turn",
        state: "completed",
        sessionStatus: "running",
        activeTurnId: "voice-turn",
        assistantMessageId: "previous-answer",
        messages: [
          {
            id: "previous-answer",
            role: "assistant",
            text: "Previous work.",
            turnId: "previous-turn",
            streaming: false,
          },
        ],
      }),
    );
    await settleTranscriptAndDispatch();
    expect(harness.errors).toEqual([]);
    expect(
      harness.sent.some((event) => String(event.content).includes("replaced this request")),
    ).toBe(false);
    expect(harness.conversation.activeMessageId).toBe(request.messageId);

    harness.conversation.update(
      makeSnapshot({
        turnId: "voice-turn",
        userMessageId: request.messageId,
        state: "completed",
        sessionStatus: "ready",
        assistantMessageId: "voice-answer",
        messages: [
          {
            id: "voice-answer",
            role: "assistant",
            text: "The voice request's own answer.",
            turnId: "voice-turn",
            streaming: false,
          },
        ],
      }),
    );
    expect(
      harness.sent.some(
        (event) =>
          event.content === "The voice request's own answer." &&
          event.delegation_id === "delegation-after-checkpoint",
      ),
    ).toBe(true);
  });

  it("keeps the owned request when an unseen earlier turn appears while the session still runs it", async () => {
    // Verifier case hiddenPredecessorWhileOwned: the earlier turn never reached this call's
    // snapshots, so only session.activeTurnId shows the voice request still owns the session.
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot());
    harness.conversation.event(transcript("Inspect the voice code.", 0, 500));
    harness.conversation.event(delegation("delegation-hidden-predecessor", 500));
    await settleTranscriptAndDispatch();
    const request = harness.requests[0]!;

    harness.conversation.update(
      makeSnapshot({
        turnId: "owned-voice-turn",
        userMessageId: request.messageId,
        state: "running",
        sessionStatus: "running",
      }),
    );
    harness.conversation.update(
      makeSnapshot({
        turnId: "earlier-turn-never-shown",
        userMessageId: "earlier-user-message",
        state: "completed",
        sessionStatus: "running",
        activeTurnId: "owned-voice-turn",
        assistantMessageId: "earlier-answer",
        messages: [
          {
            id: "earlier-answer",
            role: "assistant",
            text: "Earlier result.",
            turnId: "earlier-turn-never-shown",
            streaming: false,
          },
        ],
      }),
    );
    await settleTranscriptAndDispatch();
    expect(harness.errors).toEqual([]);
    expect(
      harness.sent.some((event) => String(event.content).includes("replaced this request")),
    ).toBe(false);
    expect(harness.sent.some((event) => event.content === "Earlier result.")).toBe(false);
    expect(harness.conversation.activeMessageId).toBe(request.messageId);

    harness.conversation.update(
      makeSnapshot({
        turnId: "owned-voice-turn",
        userMessageId: request.messageId,
        state: "completed",
        sessionStatus: "ready",
        assistantMessageId: "owned-answer",
        messages: [
          {
            id: "owned-answer",
            role: "assistant",
            text: "Owned voice answer.",
            turnId: "owned-voice-turn",
            streaming: false,
          },
        ],
      }),
    );
    const ownedAnswers = harness.sent.filter((event) => event.content === "Owned voice answer.");
    expect(ownedAnswers.map((event) => event.delegation_id)).toEqual([
      "delegation-hidden-predecessor",
    ]);
    expect(harness.conversation.activeMessageId).toBeNull();
  });

  it("returns the voice status to listening when a thread block clears with nothing queued", () => {
    // The panel shows the controller's status; a cleared approval must not leave a stale label.
    const harness = makeHarness();
    harness.conversation.update(makeSnapshot({ hasPendingApprovals: true }));
    expect(harness.statuses.at(-1)).toBe("Approval needed in thread");
    harness.conversation.update(makeSnapshot());
    expect(harness.statuses.at(-1)).toBe("Listening");
    expect(harness.dispatchSpy).not.toHaveBeenCalled();
  });

  it("answers a request spoken while an already reported approval still blocks the thread", async () => {
    // Observed in approval-draft-attachment: the block was reported when the call
    // started, so the later spoken request received only a quiet acknowledgement and
    // the caller heard nothing about why the agent did not start it.
    const harness = makeHarness();
    harness.conversation.update(
      makeSnapshot({
        turnId: "approval-turn",
        state: "running",
        sessionStatus: "running",
        hasPendingApprovals: true,
      }),
    );
    expect(harness.statuses.at(-1)).toBe("Approval needed in thread");
    const sentBeforeRequest = harness.sent.length;

    harness.conversation.event(transcript("Inspect the voice code.", 0, 500));
    harness.conversation.event(delegation("delegation-while-blocked", 500));
    await settleTranscriptAndDispatch();

    expect(harness.dispatchSpy).not.toHaveBeenCalled();
    const spokenForRequest = harness.sent
      .slice(sentBeforeRequest)
      .filter(
        (event) =>
          event.type === "session.commentary.append" &&
          event.delegation_id === "delegation-while-blocked",
      );
    expect(spokenForRequest.some((event) => /approval/i.test(String(event.content)))).toBe(true);
    expect(harness.statuses.at(-1)).toBe("Approval needed in thread");
  });
});
