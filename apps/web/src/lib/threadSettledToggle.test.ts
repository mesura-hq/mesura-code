import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createThreadSettledToggle, type ThreadSettledToggleTarget } from "./threadSettledToggle";

const threadA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-a"));
const threadB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-b"));

/**
 * Drains the microtasks between a command resolving and the toggle's `finally`
 * releasing the lock. Turns rather than a timer: the count is bounded and known,
 * and a test that needs a timeout to pass is wrong.
 */
async function drain() {
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
}

/** Commands whose completion the test decides, so the lock can be observed. */
function deferredCommands() {
  const calls: string[] = [];
  const releases: Array<() => void> = [];
  return {
    calls,
    run: (threadId: string) => {
      calls.push(threadId);
      return new Promise<void>((resolve) => {
        releases.push(resolve);
      });
    },
    /** Completes one call by the order it was made, not the order it landed. */
    finish: async (index = 0) => {
      releases[index]?.();
      await drain();
    },
  };
}

describe("createThreadSettledToggle", () => {
  it("settles an active thread and un-settles a settled one", async () => {
    let target: ThreadSettledToggleTarget = { threadRef: threadA, settled: false };
    const settled: string[] = [];
    const unsettled: string[] = [];
    const toggle = createThreadSettledToggle({
      readTarget: () => target,
      settle: async (ref) => {
        settled.push(ref.threadId);
      },
      unsettle: async (ref) => {
        unsettled.push(ref.threadId);
      },
    });

    expect(toggle.toggle()).toBe("settle");
    await drain();
    target = { threadRef: threadA, settled: true };
    expect(toggle.toggle()).toBe("unsettle");
    await drain();

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

    expect(toggle.toggle()).toBe("no-thread");
    expect(sent).toBe(false);
  });

  it("reads the target at press time, not at creation", async () => {
    let target: ThreadSettledToggleTarget | null = null;
    const settled: string[] = [];
    const toggle = createThreadSettledToggle({
      readTarget: () => target,
      settle: async (ref) => {
        settled.push(ref.threadId);
      },
      unsettle: async () => {},
    });

    expect(toggle.toggle()).toBe("no-thread");
    target = { threadRef: threadB, settled: false };
    expect(toggle.toggle()).toBe("settle");
    await drain();

    expect(settled).toEqual(["thread-b"]);
  });

  it("drops a second press for the same thread while the first is in flight", async () => {
    const commands = deferredCommands();
    const toggle = createThreadSettledToggle({
      readTarget: () => ({ threadRef: threadA, settled: false }),
      settle: (ref) => commands.run(ref.threadId),
      unsettle: async () => {},
    });

    expect(toggle.toggle()).toBe("settle");
    // The settled state still reads "active" here, exactly as it does before
    // the projection catches up. Without the lock this press would send a
    // second settle, and the thread would end up settled when the user asked
    // for the opposite.
    expect(toggle.toggle()).toBe("in-flight");
    expect(commands.calls).toEqual(["thread-a"]);

    await commands.finish();
    expect(toggle.toggle()).toBe("settle");
    expect(commands.calls).toEqual(["thread-a", "thread-a"]);
  });

  it("leaves another thread free while one is in flight", () => {
    const commands = deferredCommands();
    let target: ThreadSettledToggleTarget = { threadRef: threadA, settled: false };
    const toggle = createThreadSettledToggle({
      readTarget: () => target,
      settle: (ref) => commands.run(ref.threadId),
      unsettle: async () => {},
    });

    expect(toggle.toggle()).toBe("settle");
    target = { threadRef: threadB, settled: false };
    expect(toggle.toggle()).toBe("settle");
    expect(commands.calls).toEqual(["thread-a", "thread-b"]);
  });

  it("keeps a lock a slow command left behind on the thread that owns it", async () => {
    const commands = deferredCommands();
    let target: ThreadSettledToggleTarget = { threadRef: threadA, settled: false };
    const toggle = createThreadSettledToggle({
      readTarget: () => target,
      settle: (ref) => commands.run(ref.threadId),
      unsettle: async () => {},
    });

    toggle.toggle();
    target = { threadRef: threadB, settled: false };
    toggle.toggle();
    // Thread A's command lands after the user moved on. Releasing on completion
    // alone would clear thread B's lock, which A never held.
    await commands.finish(0);

    expect(toggle.toggle()).toBe("in-flight");
  });
});
