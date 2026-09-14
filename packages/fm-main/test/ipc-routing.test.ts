import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcReply } from "@symmetria/fm-core/contract";
import type { FsEntry } from "@symmetria/fm-core/entry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChangedEntry } from "../src/fs/watch.ts";

import { CHANNELS } from "../src/ipc/channels.ts";
import {
  createRegistry,
  type IpcHandler,
  type IpcSurface,
  type Registry,
  type SenderHandle,
} from "../src/ipc/register.ts";

/**
 * Which window a push reached.
 *
 * The registry serves one transport and, from this phase on, more than one
 * window. Every existing test in `ipc.test.ts` drives exactly one, which is why
 * none of them can see the defect these do: a routing bug that always resolves
 * to the first sender passes a single-sender suite completely.
 *
 * So every assertion here needs TWO senders and asks which one received the
 * push, never whether a push happened at all.
 */

const previewUrlFor = (token: string) => `test-host://preview/${token}`;

/** One recorded push, with the window it was addressed to. */
interface Delivery {
  readonly to: string;
  readonly channel: string;
  readonly payload: unknown;
}

/**
 * Two windows that each record what they were told.
 *
 * A window IS the thing you push to, so a recording window is the natural test
 * double — there is no separate sender to intercept. `invoke` takes the window
 * as an argument because a real `ipcMain.handle` receives it on the event; see
 * `electronSurface.ts`, which exists because the fake in `ipc.test.ts` once
 * encoded a one-argument assumption the real API did not honour.
 */
function harness() {
  const handlers = new Map<string, IpcHandler>();
  const delivered: Delivery[] = [];

  const surface: IpcSurface = {
    handle(channel, handler) {
      if (handlers.has(channel)) throw new Error(`duplicate handler for ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
  };

  const window = (name: string): SenderHandle => ({
    send: (channel, payload) => {
      delivered.push({ to: name, channel, payload });
    },
  });

  const invoke = (channel: string, payload: unknown, from: SenderHandle): Promise<IpcReply> => {
    const handler = handlers.get(channel);
    if (!handler) return Promise.reject(new Error(`no handler for ${channel}`));
    return handler(payload, from);
  };

  return {
    surface,
    invoke,
    delivered,
    /** Two windows, told apart only by which one a push arrived at. */
    windowA: window("A"),
    windowB: window("B"),
    /** Only the pushes addressed to this window, on this channel. */
    to(name: string, channel: string): Delivery[] {
      return delivered.filter((d) => d.to === name && d.channel === channel);
    },
  };
}

/**
 * A scan that never finishes on its own.
 *
 * The registry's list handler catches, checks `signal.aborted` and answers
 * `cancelled`, so rejecting on abort is what drives that branch. Without a scan
 * that hangs, a cancellation test races the filesystem and passes for the wrong
 * reason on a fast machine.
 */
function hangingScan(): (path: string, options?: { signal?: AbortSignal }) => Promise<FsEntry[]> {
  return (_path, options) =>
    new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
}

/**
 * A listing entry, written out in full rather than asserted into shape.
 *
 * `as unknown as FsEntry` would have been shorter and the anti-slop gate
 * rejects an assertion chain outright — rightly, since it discards exactly the
 * evidence that would catch a field being renamed under this test.
 */
function entry(name: string): FsEntry {
  return {
    name,
    kind: "file",
    size: 1,
    modifiedMs: 0,
    isSymlink: false,
    isHidden: false,
    unreadable: false,
  };
}

/** Real files, for the one case that cannot be stubbed. */
let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "symfm-routing-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("a push reaches the window that asked for it", () => {
  it("delivers a streamed listing's batches only to the requesting window", async () => {
    const h = harness();
    createRegistry(h.surface, {
      previewUrlFor,
      scanDirectory: () => Promise.resolve([entry("one.txt"), entry("two.txt")]),
    });

    const reply = await h.invoke(CHANNELS.list, { path: "/tmp", stream: true }, h.windowA);

    expect(reply.ok).toBe(true);
    expect(h.to("A", CHANNELS.listBatch).length).toBeGreaterThan(0);
    expect(h.to("B", CHANNELS.listBatch)).toEqual([]);
  });

  it("delivers a directory-changed notification only to the watching window", async () => {
    const h = harness();
    // Collected rather than held in a `let`: TypeScript's control flow cannot
    // see that the callback below ran, so a nullable variable assigned inside
    // it narrows to `never` at the call and will not compile.
    const listeners: ((changed: ChangedEntry[]) => void)[] = [];
    createRegistry(h.surface, {
      previewUrlFor,
      watchDirectory: (_path, onChange) => {
        listeners.push(onChange);
        return Promise.resolve(async () => undefined);
      },
    });

    await h.invoke(CHANNELS.watch, { path: "/tmp", subscriptionId: "s1" }, h.windowB);
    for (const notify of listeners) notify([]);

    expect(h.to("B", CHANNELS.changed).length).toBe(1);
    expect(h.to("A", CHANNELS.changed)).toEqual([]);
  });

  it("gives two windows the same subscription id without either stealing the other's watch", async () => {
    // Both maps are keyed by an id the RENDERER chooses, and two renderers
    // choose independently. A picker window opening `s1` while the browse
    // window holds `s1` must not release the browse window's watch.
    const h = harness();
    const stopped: string[] = [];
    let opened = 0;
    createRegistry(h.surface, {
      previewUrlFor,
      watchDirectory: () => {
        const mine = `w${opened++}`;
        return Promise.resolve(async () => {
          stopped.push(mine);
        });
      },
    });

    await h.invoke(CHANNELS.watch, { path: "/tmp", subscriptionId: "s1" }, h.windowA);
    await h.invoke(CHANNELS.watch, { path: "/var", subscriptionId: "s1" }, h.windowB);

    expect(opened).toBe(2);
    expect(stopped).toEqual([]);
  });

  it("delivers transfer progress only to the window that started the transfer", async () => {
    // The third push named by the acceptance criterion, and the one the other
    // cases here would not have caught: the transfer handler pushes straight to
    // `from` without ever touching the per-window resource map, so it is a
    // structurally different path from the listing and the watch.
    //
    // A real copy on real files, because `operations` is a module-level import
    // rather than an injected dependency — there is nothing to stub.
    const h = harness();
    createRegistry(h.surface, { previewUrlFor });

    const source = join(scratch, "to-copy.txt");
    const destination = join(scratch, "into");
    await writeFile(source, "some bytes");
    await mkdir(destination, { recursive: true });

    const reply = await h.invoke(
      CHANNELS.transfer,
      { sources: [source], destination, mode: "copy", transferId: "t1" },
      h.windowA,
    );

    expect(reply.ok).toBe(true);
    expect(h.to("A", CHANNELS.transferProgress).length).toBeGreaterThan(0);
    expect(h.to("B", CHANNELS.transferProgress)).toEqual([]);
  });
});

describe("cancelling everything cancels only one window's everything", () => {
  it("does not remember a window that only ever cancelled", async () => {
    // A renderer clearing up on unmount sends `cancel` with nothing in flight.
    // Answering it used to CREATE that window's resource record, which then sat
    // in a strongly-keyed map for a window that never came back — one dead
    // entry per file dialog, on a daemon that runs for days. Review found it.
    //
    // Asserted through `trackedWindows`, and that method exists because of this
    // test: every other observable — the reply, the dispose, the pushes —
    // behaved identically with the leak and without it, so a test written
    // without a window count would have passed on the bug.
    const h = harness();
    const registry: Registry = createRegistry(h.surface, {
      previewUrlFor,
      watchDirectory: () => Promise.resolve(async () => undefined),
    });

    await h.invoke(CHANNELS.watch, { path: "/a-window", subscriptionId: "s1" }, h.windowA);
    expect(registry.trackedWindows()).toBe(1);

    const reply = await h.invoke(CHANNELS.cancel, { streamId: "all" }, h.windowB);

    // Cancelling nothing still succeeds — it is not an error to have nothing
    // to cancel, and a failure here would make an unmount look broken.
    expect(reply.ok).toBe(true);
    expect(registry.trackedWindows()).toBe(1);
  });

  it("leaves the other window's stream running", async () => {
    const h = harness();
    createRegistry(h.surface, { previewUrlFor, scanDirectory: hangingScan() });

    const a = h.invoke(CHANNELS.list, { path: "/tmp", stream: true, streamId: "a1" }, h.windowA);
    const b = h.invoke(CHANNELS.list, { path: "/tmp", stream: true, streamId: "b1" }, h.windowB);

    await h.invoke(CHANNELS.cancel, { streamId: "all" }, h.windowA);

    const replyA = await a;
    expect(replyA.ok).toBe(false);
    if (replyA.ok) return;
    expect(replyA.error.code).toBe("cancelled");

    // B's scan is still hanging, which is the whole assertion: a settled promise
    // here would mean one window's tab-close abandoned another window's work.
    const outcome = await Promise.race([
      b.then(() => "settled" as const),
      new Promise<"still running">((resolve) => setTimeout(() => resolve("still running"), 50)),
    ]);
    expect(outcome).toBe("still running");
  });
});

describe("closing one window releases only its own resources", () => {
  it("stops that window's watches and leaves the other window's open", async () => {
    const h = harness();
    const stopped: string[] = [];
    const registry: Registry = createRegistry(h.surface, {
      previewUrlFor,
      watchDirectory: (path) =>
        Promise.resolve(async () => {
          stopped.push(path);
        }),
    });

    await h.invoke(CHANNELS.watch, { path: "/a-window", subscriptionId: "s1" }, h.windowA);
    await h.invoke(CHANNELS.watch, { path: "/b-window", subscriptionId: "s2" }, h.windowB);

    registry.disposeSender(h.windowA);
    await new Promise((r) => setTimeout(r, 20));

    expect(stopped).toEqual(["/a-window"]);
  });

  it("aborts that window's streams and leaves the other window's running", async () => {
    const h = harness();
    const registry: Registry = createRegistry(h.surface, {
      previewUrlFor,
      scanDirectory: hangingScan(),
    });

    const a = h.invoke(CHANNELS.list, { path: "/tmp", stream: true, streamId: "a1" }, h.windowA);
    const b = h.invoke(CHANNELS.list, { path: "/tmp", stream: true, streamId: "b1" }, h.windowB);

    registry.disposeSender(h.windowA);

    const replyA = await a;
    expect(replyA.ok).toBe(false);
    if (replyA.ok) return;
    expect(replyA.error.code).toBe("cancelled");

    const outcome = await Promise.race([
      b.then(() => "settled" as const),
      new Promise<"still running">((resolve) => setTimeout(() => resolve("still running"), 50)),
    ]);
    expect(outcome).toBe("still running");
  });

  it("still releases every window's resources on a whole-registry dispose", async () => {
    // `disposeSender` is the new lever and `dispose` is the old one. The old one
    // runs at quit and must keep meaning "everything", or a process shutting
    // down leaks whatever the last window happened not to own.
    const h = harness();
    const stopped: string[] = [];
    const registry: Registry = createRegistry(h.surface, {
      previewUrlFor,
      watchDirectory: (path) =>
        Promise.resolve(async () => {
          stopped.push(path);
        }),
    });

    await h.invoke(CHANNELS.watch, { path: "/a-window", subscriptionId: "s1" }, h.windowA);
    await h.invoke(CHANNELS.watch, { path: "/b-window", subscriptionId: "s2" }, h.windowB);

    registry.dispose();
    await new Promise((r) => setTimeout(r, 20));

    expect(stopped.sort()).toEqual(["/a-window", "/b-window"]);
  });
});
