// Entry point: voiceHistoryState.ts, the state VoiceHistoryPanel delegates to. Notices are folded
// before they become atom state, refreshes are planned from that fold, and one serialized reader
// owns each selected call's transcript.
import type { VoiceCallSummary, VoiceTranscriptFragment } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createVoiceTranscriptReader,
  foldVoiceHistoryNotice,
  initialVoiceHistoryNotices,
  planVoiceHistoryRefresh,
  type VoiceTranscriptPage,
} from "./voiceHistoryState";

const summary = (callId: string, overrides: Partial<VoiceCallSummary> = {}): VoiceCallSummary => ({
  callId,
  threadId: "thread-1" as VoiceCallSummary["threadId"],
  startedAt: "2026-11-08T10:00:00.000Z",
  endedAt: null,
  endReason: null,
  finalSequence: null,
  lastSequence: 0,
  ownedByRequester: false,
  ...overrides,
});

const fragment = (sequence: number): VoiceTranscriptFragment => ({
  fragmentId: `fragment-${sequence}` as VoiceTranscriptFragment["fragmentId"],
  sequence,
  speaker: sequence % 2 ? "user" : "assistant",
  text: `fragment ${sequence}`,
});

/** A call whose server holds `total` fragments, read in pages of 100. */
const serverPage = (afterSequence: number | null, total: number, call: VoiceCallSummary) => {
  const start = (afterSequence ?? 0) + 1;
  const end = Math.min(start + 99, total);
  const fragments = Array.from({ length: Math.max(0, end - start + 1) }, (_, i) =>
    fragment(start + i),
  );
  return { call, fragments, nextAfterSequence: end < total ? end : null };
};

/**
 * A read the test answers explicitly, so response order is under the test's control. `issued(n)`
 * is the receipt that the reader has started its n-th read.
 */
const controlledReads = () => {
  const pending: Array<{
    afterSequence: number | null;
    answer: (page: VoiceTranscriptPage) => void;
  }> = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  return {
    pending,
    read: (afterSequence: number | null) =>
      new Promise<VoiceTranscriptPage>((answer) => {
        pending.push({ afterSequence, answer });
        for (const waiter of waiters.filter((candidate) => pending.length >= candidate.count))
          waiter.resolve();
      }),
    issued: (count: number) =>
      new Promise<void>((resolve) => {
        if (pending.length >= count) resolve();
        else waiters.push({ count, resolve });
      }),
  };
};

describe("voice history notices", () => {
  it("voice history keeps every dirty call when two notices arrive before React reads them", () => {
    let notices = initialVoiceHistoryNotices(1);
    notices = foldVoiceHistoryNotice(notices, { kind: "subscribed" });
    const baseline = planVoiceHistoryRefresh({
      notices,
      previous: null,
      selectedCallId: "call-a",
      firstPageCallIds: ["call-new"],
      loadedCallIds: ["call-new", "call-a", "call-b"],
    });
    // Call A (selected, beyond the first page) then call B change before React commits.
    notices = foldVoiceHistoryNotice(notices, {
      kind: "call-changed",
      callId: "call-a",
      change: "ended",
      sequence: 40,
    });
    notices = foldVoiceHistoryNotice(notices, {
      kind: "call-changed",
      callId: "call-b",
      change: "appended",
      sequence: 41,
    });

    const plan = planVoiceHistoryRefresh({
      notices,
      previous: baseline.handled,
      selectedCallId: "call-a",
      firstPageCallIds: ["call-new"],
      loadedCallIds: ["call-new", "call-a", "call-b"],
    });
    expect(plan.resync).toBe(false);
    expect(plan.readSelected).toBe(true);
    expect(plan.summaryCallIds).toEqual(["call-b"]);
    expect(plan.refreshFirstPage).toBe(true);

    // The same fold planned again has nothing left to do.
    const again = planVoiceHistoryRefresh({
      notices,
      previous: plan.handled,
      selectedCallId: "call-a",
      firstPageCallIds: ["call-new"],
      loadedCallIds: ["call-new", "call-a", "call-b"],
    });
    expect(again).toMatchObject({
      resync: false,
      readSelected: false,
      summaryCallIds: [],
      refreshFirstPage: false,
    });
  });

  it("voice history reconnect re-reads a selected call beyond the first page", () => {
    const loaded = Array.from({ length: 21 }, (_, i) => `call-${i + 1}`);
    const first = foldVoiceHistoryNotice(initialVoiceHistoryNotices(1), { kind: "subscribed" });
    const before = planVoiceHistoryRefresh({
      notices: first,
      previous: null,
      selectedCallId: "call-21",
      firstPageCallIds: loaded.slice(0, 20),
      loadedCallIds: loaded,
    });
    // The socket reconnected: a new subscription delivers its own receipt, and no call notice
    // describes what was saved meanwhile.
    const reconnected = foldVoiceHistoryNotice(initialVoiceHistoryNotices(2), {
      kind: "subscribed",
    });
    const plan = planVoiceHistoryRefresh({
      notices: reconnected,
      previous: before.handled,
      selectedCallId: "call-21",
      firstPageCallIds: loaded.slice(0, 20),
      loadedCallIds: loaded,
    });
    expect(plan.resync).toBe(true);
    expect(plan.readSelected).toBe(true);
  });

  it("voice history overflow resync re-reads like a new subscription", () => {
    let notices = foldVoiceHistoryNotice(initialVoiceHistoryNotices(1), { kind: "subscribed" });
    const before = planVoiceHistoryRefresh({
      notices,
      previous: null,
      selectedCallId: "call-21",
      firstPageCallIds: [],
      loadedCallIds: ["call-21"],
    });
    notices = foldVoiceHistoryNotice(notices, { kind: "resync" });
    const plan = planVoiceHistoryRefresh({
      notices,
      previous: before.handled,
      selectedCallId: "call-21",
      firstPageCallIds: [],
      loadedCallIds: ["call-21"],
    });
    expect(plan).toMatchObject({ resync: true, readSelected: true });
  });
});

describe("voice history notice order", () => {
  it("voice history ignores a repeated or older notice for a call already handled", () => {
    let notices = foldVoiceHistoryNotice(initialVoiceHistoryNotices(1), { kind: "subscribed" });
    notices = foldVoiceHistoryNotice(notices, {
      kind: "call-changed",
      callId: "call-a",
      change: "appended",
      sequence: 9,
    });
    const handled = planVoiceHistoryRefresh({
      notices,
      previous: planVoiceHistoryRefresh({
        notices: foldVoiceHistoryNotice(initialVoiceHistoryNotices(1), { kind: "subscribed" }),
        previous: null,
        selectedCallId: "call-a",
        firstPageCallIds: [],
        loadedCallIds: ["call-a"],
      }).handled,
      selectedCallId: "call-a",
      firstPageCallIds: [],
      loadedCallIds: ["call-a"],
    }).handled;
    // The same notice again, then one with an older sequence, arrive late.
    const repeated = foldVoiceHistoryNotice(notices, {
      kind: "call-changed",
      callId: "call-a",
      change: "appended",
      sequence: 9,
    });
    const older = foldVoiceHistoryNotice(repeated, {
      kind: "call-changed",
      callId: "call-a",
      change: "started",
      sequence: 3,
    });
    expect(older.calls.get("call-a")).toBe(9);
    expect(
      planVoiceHistoryRefresh({
        notices: older,
        previous: handled,
        selectedCallId: "call-a",
        firstPageCallIds: [],
        loadedCallIds: ["call-a"],
      }),
    ).toMatchObject({
      resync: false,
      readSelected: false,
      summaryCallIds: [],
      refreshFirstPage: false,
    });
  });
});

describe("voice transcript reader", () => {
  it("voice transcript reader keeps unread pages reachable when an invalidation lands during a slow read", async () => {
    const call = summary("call-21", { lastSequence: 250 });
    const reads = controlledReads();
    const reader = createVoiceTranscriptReader({ read: reads.read, onUpdate: () => {} });

    const opened = reader.request();
    // A notice arrives while the first page is still in flight: it is retained, not raced.
    const invalidated = reader.request();
    await reads.issued(1);
    expect(reads.pending.map((read) => read.afterSequence)).toEqual([null]);

    reads.pending[0]!.answer(serverPage(null, 250, call));
    await reads.issued(2);
    expect(reads.pending.map((read) => read.afterSequence)).toEqual([null, 100]);
    reads.pending[1]!.answer(serverPage(100, 250, call));
    await Promise.all([opened, invalidated]);

    expect(
      reader
        .snapshot()
        .fragments.map((item) => item.sequence)
        .at(-1),
    ).toBe(200);
    expect(reader.snapshot().hasMore).toBe(true);

    // Load more reaches the last 50 fragments.
    const more = reader.request();
    await reads.issued(3);
    reads.pending[2]!.answer(serverPage(200, 250, call));
    await more;
    expect(reads.pending.map((read) => read.afterSequence)).toEqual([null, 100, 200]);
    expect(reader.snapshot().fragments).toHaveLength(250);
    expect(reader.snapshot().hasMore).toBe(false);
  });

  it("voice transcript reader never moves its cursor back or duplicates fragments", async () => {
    const call = summary("call-1", { lastSequence: 3 });
    const reads = controlledReads();
    const reader = createVoiceTranscriptReader({ read: reads.read, onUpdate: () => {} });
    const first = reader.request();
    await reads.issued(1);
    reads.pending[0]!.answer({
      call,
      fragments: [fragment(1), fragment(2), fragment(3)],
      nextAfterSequence: null,
    });
    await first;
    const second = reader.request();
    await reads.issued(2);
    expect(reads.pending[1]!.afterSequence).toBe(3);
    // An overlapping answer repeats fragments the reader already holds.
    reads.pending[1]!.answer({
      call,
      fragments: [fragment(2), fragment(3)],
      nextAfterSequence: null,
    });
    await second;
    expect(reader.snapshot().fragments.map((item) => item.sequence)).toEqual([1, 2, 3]);
  });

  it("voice transcript reader shows the summary the transcript returned, from Live to Saved", async () => {
    const reads = controlledReads();
    const updates: Array<string> = [];
    const reader = createVoiceTranscriptReader({
      read: reads.read,
      onUpdate: (snapshot) => {
        if (snapshot.call) updates.push(snapshot.call.endReason ?? "live");
      },
    });
    const live = reader.request();
    await reads.issued(1);
    reads.pending[0]!.answer({
      call: summary("call-21", { lastSequence: 1 }),
      fragments: [fragment(1)],
      nextAfterSequence: null,
    });
    await live;
    const ended = reader.request();
    await reads.issued(2);
    reads.pending[1]!.answer({
      call: summary("call-21", {
        endedAt: "2026-11-08T10:05:00.000Z",
        endReason: "hangup",
        finalSequence: 1,
        lastSequence: 1,
      }),
      fragments: [],
      nextAfterSequence: null,
    });
    await ended;
    expect(reader.snapshot().call).toMatchObject({ endReason: "hangup", finalSequence: 1 });
    expect(updates).toEqual(["live", "hangup"]);
  });

  it("voice transcript reader ignores a response that lands after the call was closed", async () => {
    const reads = controlledReads();
    const updates: unknown[] = [];
    const reader = createVoiceTranscriptReader({
      read: reads.read,
      onUpdate: (snapshot) => updates.push(snapshot),
    });
    const pending = reader.request();
    await reads.issued(1);
    const before = updates.length;
    reader.dispose();
    reads.pending[0]!.answer(serverPage(null, 10, summary("call-1")));
    await pending;
    expect(updates).toHaveLength(before);
    expect(reads.pending).toHaveLength(1);
  });

  it("voice transcript reader reports a failed read and resumes from the same cursor", async () => {
    const call = summary("call-1", { lastSequence: 150 });
    const reads = controlledReads();
    const failures: Array<(cause: Error) => void> = [];
    let failNext = false;
    const reader = createVoiceTranscriptReader({
      read: (afterSequence) =>
        failNext
          ? new Promise<VoiceTranscriptPage>((_, reject) => {
              failNext = false;
              failures.push(reject);
            })
          : reads.read(afterSequence),
      onUpdate: () => {},
      describeError: (cause) => (cause instanceof Error ? cause.message : "failed"),
    });
    const first = reader.request();
    await reads.issued(1);
    reads.pending[0]!.answer(serverPage(null, 150, call));
    await first;

    failNext = true;
    const failed = reader.request();
    failures[0]!(new Error("connection lost"));
    await failed;
    // The fragments already read stay; the failure is shown, not hidden.
    expect(reader.snapshot()).toMatchObject({ error: "connection lost", hasMore: true });
    expect(reader.snapshot().fragments).toHaveLength(100);

    const retried = reader.request();
    await reads.issued(2);
    expect(reads.pending[1]!.afterSequence).toBe(100);
    reads.pending[1]!.answer(serverPage(100, 150, call));
    await retried;
    expect(reader.snapshot()).toMatchObject({ error: null, hasMore: false });
    expect(reader.snapshot().fragments).toHaveLength(150);
  });
});
