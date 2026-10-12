import { ThreadId, type WorktreeSetupSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { advanceChatViewWorktreeSetupHistory } from "./chatViewWorktreeSetupHistory";

const firstThreadId = ThreadId.make("history-thread-a");
const secondThreadId = ThreadId.make("history-thread-b");
const snapshot = (sequence: number, threadId = firstThreadId): WorktreeSetupSnapshot => ({
  threadId,
  sequence,
  phase: "running",
  startedAt: "2026-10-12T00:00:00.000Z",
  endedAt: null,
  branch: "feature",
  baseRef: "main",
  worktreePath: null,
  setupScript: null,
  stages: [],
  error: null,
});

describe("ChatView worktree setup history preserves query and route boundaries", () => {
  it("history initial route reset wins over a simultaneously available snapshot", () => {
    const latest = snapshot(5);
    const history = advanceChatViewWorktreeSetupHistory(null, "env:thread-a", latest);
    expect(history.heldSnapshot).toBeNull();
    expect(history.lastObservedSnapshot).toBe(latest);
    expect(advanceChatViewWorktreeSetupHistory(history, "env:thread-a", latest)).toBe(history);
  });

  it.each([null, undefined])(
    "history retains streamed progress when the query becomes %s",
    (empty) => {
      const initial = advanceChatViewWorktreeSetupHistory(null, "env:thread-a", null);
      const latest = snapshot(8);
      const held = advanceChatViewWorktreeSetupHistory(initial, "env:thread-a", latest);
      const next = advanceChatViewWorktreeSetupHistory(held, "env:thread-a", empty);
      expect(next.heldSnapshot).toBe(latest);
      expect(next.lastObservedSnapshot).toBe(empty);
      expect(advanceChatViewWorktreeSetupHistory(next, "env:thread-a", empty)).toBe(next);
    },
  );

  it("history keeps the newest same-thread sequence across older stream identities", () => {
    const initial = advanceChatViewWorktreeSetupHistory(null, "env:thread-a", null);
    const newest = snapshot(9);
    const held = advanceChatViewWorktreeSetupHistory(initial, "env:thread-a", newest);
    const older = snapshot(4);
    const next = advanceChatViewWorktreeSetupHistory(held, "env:thread-a", older);
    expect(next.heldSnapshot).toBe(newest);
    expect(next.lastObservedSnapshot).toBe(older);
    const newer = snapshot(10);
    expect(advanceChatViewWorktreeSetupHistory(next, "env:thread-a", newer).heldSnapshot).toBe(
      newer,
    );
  });

  it("history accepts a replacement same-sequence snapshot identity", () => {
    const initial = advanceChatViewWorktreeSetupHistory(null, "env:thread-a", null);
    const first = snapshot(7);
    const held = advanceChatViewWorktreeSetupHistory(initial, "env:thread-a", first);
    const replacement = { ...first, phase: "cancelled" as const };
    expect(
      advanceChatViewWorktreeSetupHistory(held, "env:thread-a", replacement).heldSnapshot,
    ).toBe(replacement);
  });

  it("history accepts a different setup thread without comparing its sequence", () => {
    const initial = advanceChatViewWorktreeSetupHistory(null, "env:thread-a", null);
    const held = advanceChatViewWorktreeSetupHistory(initial, "env:thread-a", snapshot(20));
    const replacement = snapshot(1, secondThreadId);
    expect(
      advanceChatViewWorktreeSetupHistory(held, "env:thread-a", replacement).heldSnapshot,
    ).toBe(replacement);
  });

  it("history route reset wins over a new snapshot and unchanged identity cannot resurrect it", () => {
    const initial = advanceChatViewWorktreeSetupHistory(null, "env:thread-a", null);
    const held = advanceChatViewWorktreeSetupHistory(initial, "env:thread-a", snapshot(8));
    const simultaneous = snapshot(2, secondThreadId);
    const reset = advanceChatViewWorktreeSetupHistory(held, "env:thread-b", simultaneous);
    expect(reset.heldSnapshot).toBeNull();
    expect(reset.lastObservedSnapshot).toBe(simultaneous);
    expect(advanceChatViewWorktreeSetupHistory(reset, "env:thread-b", simultaneous)).toBe(reset);
    const later = snapshot(3, secondThreadId);
    expect(advanceChatViewWorktreeSetupHistory(reset, "env:thread-b", later).heldSnapshot).toBe(
      later,
    );
  });
});
