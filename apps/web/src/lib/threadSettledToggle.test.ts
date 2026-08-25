import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createThreadSettledToggle, type ThreadSettledToggleTarget } from "./threadSettledToggle";

const threadA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-a"));
const threadB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-b"));

/**
 * Commands whose completion the test decides, so the lock can be observed.
 *
 * `finish` waits on the command's own promise rather than counting microtask
 * turns. A counted drain passes for the wrong reason the moment an await layer
 * is added: it under-drains, the release is never observed, and the assertion
 * that the lock cleared silently stops testing anything.
 */
function deferredCommands() {
  const calls: string[] = [];
  const settlements: Array<{ readonly promise: Promise<void>; readonly release: () => void }> = [];
  return {
    calls,
    run: (threadId: string) => {
      calls.push(threadId);
      let release = () => {};
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      settlements.push({ promise, release });
      return promise;
    },
    /** Completes one call by the order it was made, not the order it landed. */
    finish: async (index = 0) => {
      const settlement = settlements[index];
      if (!settlement) throw new Error(`no command at index ${index}`);
      settlement.release();
      await settlement.promise;
      // One more turn for the toggle's own `finally` to run after its await.
      await Promise.resolve();
    },
  };
}

describe("createThreadSettledToggle", () => {
  it("settles an active thread and un-settles a settled one", async () => {
    const commands = deferredCommands();
    let target: ThreadSettledToggleTarget = { threadRef: threadA, settled: false };
    const settled: string[] = [];
    const unsettled: string[] = [];
    const toggle = createThreadSettledToggle({
      readTarget: () => target,
      settle: (ref) => {
        settled.push(ref.threadId);
        return commands.run(ref.threadId);
      },
      unsettle: (ref) => {
        unsettled.push(ref.threadId);
        return commands.run(ref.threadId);
      },
    });

    expect(toggle()).toBe("settle");
    await commands.finish(0);
    target = { threadRef: threadA, settled: true };
    expect(toggle()).toBe("unsettle");
    await commands.finish(1);

    expect(settled).toEqual(["thread-a"]);
    expect(unsettled).toEqual(["thread-a"]);
  });

  it("reports no thread rather than sending a command", () => {
    let sent = false;
    const toggle = createThreadSettledToggle({
      readTarget: () => null,
      settle: async () => {
        sent = true;
      },
      unsettle: async () => {
        sent = true;
      },
    });

    expect(toggle()).toBe("no-thread");
    expect(sent).toBe(false);
  });

  it("reads the target at press time, not at creation", async () => {
    const commands = deferredCommands();
    let target: ThreadSettledToggleTarget | null = null;
    const toggle = createThreadSettledToggle({
      readTarget: () => target,
      settle: (ref) => commands.run(ref.threadId),
      unsettle: async () => {},
    });

    expect(toggle()).toBe("no-thread");
    target = { threadRef: threadB, settled: false };
    expect(toggle()).toBe("settle");
    await commands.finish();

    expect(commands.calls).toEqual(["thread-b"]);
  });

  it("drops a second press for the same thread while the first is in flight", async () => {
    const commands = deferredCommands();
    const toggle = createThreadSettledToggle({
      readTarget: () => ({ threadRef: threadA, settled: false }),
      settle: (ref) => commands.run(ref.threadId),
      unsettle: async () => {},
    });

    expect(toggle()).toBe("settle");
    // The settled state still reads "active" here, exactly as it does before
    // the projection catches up. Without the lock this press would send a
    // second settle, and the thread would end up settled when the user asked
    // for the opposite.
    expect(toggle()).toBe("in-flight");
    expect(commands.calls).toEqual(["thread-a"]);

    await commands.finish();
    expect(toggle()).toBe("settle");
    expect(commands.calls).toEqual(["thread-a", "thread-a"]);
  });

  it("drops a second press while an un-settle is in flight", () => {
    const commands = deferredCommands();
    const toggle = createThreadSettledToggle({
      readTarget: () => ({ threadRef: threadA, settled: true }),
      settle: async () => {},
      unsettle: (ref) => commands.run(ref.threadId),
    });

    expect(toggle()).toBe("unsettle");
    expect(toggle()).toBe("in-flight");
    expect(commands.calls).toEqual(["thread-a"]);
  });

  it("leaves another thread free while one is in flight", () => {
    const commands = deferredCommands();
    let target: ThreadSettledToggleTarget = { threadRef: threadA, settled: false };
    const toggle = createThreadSettledToggle({
      readTarget: () => target,
      settle: (ref) => commands.run(ref.threadId),
      unsettle: async () => {},
    });

    expect(toggle()).toBe("settle");
    target = { threadRef: threadB, settled: false };
    expect(toggle()).toBe("settle");
    expect(commands.calls).toEqual(["thread-a", "thread-b"]);
  });

  it("keeps a thread locked when a press on another thread follows it", () => {
    const commands = deferredCommands();
    let target: ThreadSettledToggleTarget = { threadRef: threadA, settled: false };
    const toggle = createThreadSettledToggle({
      readTarget: () => target,
      settle: (ref) => commands.run(ref.threadId),
      unsettle: async () => {},
    });

    toggle();
    target = { threadRef: threadB, settled: false };
    toggle();
    // A single-slot lock would have let B's press overwrite A's entry, leaving
    // A unlocked with its command still travelling.
    target = { threadRef: threadA, settled: false };
    expect(toggle()).toBe("in-flight");
    expect(commands.calls).toEqual(["thread-a", "thread-b"]);
  });

  it("releases only the thread whose command completed", async () => {
    const commands = deferredCommands();
    let target: ThreadSettledToggleTarget = { threadRef: threadA, settled: false };
    const toggle = createThreadSettledToggle({
      readTarget: () => target,
      settle: (ref) => commands.run(ref.threadId),
      unsettle: async () => {},
    });

    toggle();
    target = { threadRef: threadB, settled: false };
    toggle();
    await commands.finish(0);

    // A's command landed, so A is free again and B is still held.
    expect(toggle()).toBe("in-flight");
    target = { threadRef: threadA, settled: false };
    expect(toggle()).toBe("settle");
  });

  it("releases the lock after a command that reported a failure", async () => {
    const commands = deferredCommands();
    const reported: string[] = [];
    const toggle = createThreadSettledToggle({
      readTarget: () => ({ threadRef: threadA, settled: false }),
      // Mirrors the hook: failures are reported, never thrown.
      settle: async (ref) => {
        await commands.run(ref.threadId);
        reported.push("Failed to settle thread");
      },
      unsettle: async () => {},
    });

    expect(toggle()).toBe("settle");
    await commands.finish();

    expect(reported).toEqual(["Failed to settle thread"]);
    expect(toggle()).toBe("settle");
  });
});
