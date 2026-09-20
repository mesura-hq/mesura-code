/**
 * Every pending search settles, whatever happens to the child.
 *
 * This is the half of the protocol that used to live inside the Electron
 * adapter, where no test could reach it — and it had no `exit` handling at all,
 * so a worker that crashed left the renderer's `invoke` waiting forever. A hung
 * promise is the worst shape this failure can take: no error, no crash, just a
 * finder that never draws and a user who thinks the tree has no matches.
 *
 * The channel is a double rather than a process. What is being exercised is the
 * bookkeeping, and a real fork would only make the same assertions slower and
 * flakier — `topology.test.ts` is where two real processes earn their cost.
 */
import { describe, expect, it } from "vitest";

import { createWorkerClient, type WorkerChannel } from "../src/main/client.ts";
import type { WorkerMessage, WorkerRequest } from "../src/main/worker.ts";

interface Harness {
  readonly channel: WorkerChannel;
  readonly posted: WorkerRequest[];
  readonly killed: () => number;
  /** Deliver a message as if the child had sent it. */
  readonly deliver: (message: WorkerMessage) => void;
  /** Report the child gone, as a crash or a kill would. */
  readonly exit: (reason: string) => void;
}

function harness(): Harness {
  const posted: WorkerRequest[] = [];
  let kills = 0;
  let onMessage: (message: WorkerMessage) => void = () => {};
  let onExit: (reason: string) => void = () => {};
  return {
    channel: {
      post: (request) => posted.push(request),
      onMessage: (handler) => {
        onMessage = handler;
      },
      onExit: (handler) => {
        onExit = handler;
      },
      kill: () => {
        kills += 1;
      },
    },
    posted,
    killed: () => kills,
    deliver: (message) => onMessage(message),
    exit: (reason) => onExit(reason),
  };
}

const reply = { rows: [], matchedQuery: "q", truncated: false, cap: 200 };

describe("readiness", () => {
  it("settles when the child says its index opened", async () => {
    const child = harness();
    const client = createWorkerClient("/a", child.channel);
    child.deliver({ ready: true });
    await expect(client.ready).resolves.toBeUndefined();
  });

  it("rejects with the reason the index never opened", async () => {
    // The bug this replaces: the adapter's message router dropped every
    // message without an `id`, so BOTH readiness outcomes were discarded and
    // `searchStart` reported success for a directory that could not be indexed.
    const child = harness();
    const client = createWorkerClient("/a", child.channel);
    child.deliver({ ready: false, reason: "permission denied" });
    await expect(client.ready).rejects.toThrow("permission denied");
  });

  it("rejects when the child dies before saying anything", async () => {
    const child = harness();
    const client = createWorkerClient("/a", child.channel);
    child.exit("the search worker exited with code 78");
    await expect(client.ready).rejects.toThrow("code 78");
  });
});

describe("a search against a live worker", () => {
  it("waits for readiness before posting anything to the child", async () => {
    // Posting first is how a message reaches a process that has already exited
    // after failing to open, and is never answered.
    const child = harness();
    const client = createWorkerClient("/a", child.channel);
    const pending = client.search("q");
    await Promise.resolve();
    expect(child.posted).toEqual([]);

    child.deliver({ ready: true });
    await Promise.resolve();
    expect(child.posted).toEqual([{ id: 1, kind: "search", query: "q" }]);

    child.deliver({ id: 1, ok: true, reply });
    await expect(pending).resolves.toEqual(reply);
  });

  it("matches each reply to its own request, even out of order", async () => {
    // Replies overtake each other under a fast typist: a query over a small
    // subtree answers before an earlier one over the whole tree.
    const child = harness();
    const client = createWorkerClient("/a", child.channel);
    child.deliver({ ready: true });
    const first = client.search("slow");
    const second = client.search("fast");
    await Promise.resolve();

    child.deliver({ id: 2, ok: true, reply: { ...reply, matchedQuery: "fast" } });
    child.deliver({ id: 1, ok: true, reply: { ...reply, matchedQuery: "slow" } });

    expect((await first).matchedQuery).toBe("slow");
    expect((await second).matchedQuery).toBe("fast");
  });

  it("rejects the one search that failed and leaves the others alone", async () => {
    const child = harness();
    const client = createWorkerClient("/a", child.channel);
    child.deliver({ ready: true });
    const failing = client.search("bad");
    const fine = client.search("good");
    await Promise.resolve();

    child.deliver({ id: 1, ok: false, reason: "the engine gave up" });
    child.deliver({ id: 2, ok: true, reply });

    await expect(failing).rejects.toThrow("the engine gave up");
    await expect(fine).resolves.toEqual(reply);
  });
});

describe("when the child goes away", () => {
  it("rejects every search still in flight rather than hanging it", async () => {
    // The defect this exists for. Two in flight, so a fix that only settled the
    // most recent one could not pass.
    const child = harness();
    const client = createWorkerClient("/a", child.channel);
    child.deliver({ ready: true });
    const first = client.search("a");
    const second = client.search("b");
    await Promise.resolve();

    child.exit("the search worker exited with code 139");

    await expect(first).rejects.toThrow("code 139");
    await expect(second).rejects.toThrow("code 139");
  });

  it("rejects a search asked for after the child is already gone", async () => {
    const child = harness();
    const client = createWorkerClient("/a", child.channel);
    child.deliver({ ready: true });
    child.exit("the search worker exited with code 139");
    await expect(client.search("a")).rejects.toThrow("code 139");
    // Nothing was posted to a process that is not there to read it.
    expect(child.posted).toEqual([]);
  });

  it("stops holding the resolvers, so a dead worker leaks nothing", async () => {
    const child = harness();
    const client = createWorkerClient("/a", child.channel);
    child.deliver({ ready: true });
    const pending = client.search("a");
    await Promise.resolve();
    child.exit("gone");
    await expect(pending).rejects.toThrow("gone");
    // A late reply for a request already abandoned must not throw or resolve
    // anything: the entry is gone from the map, so this is a no-op.
    expect(() => child.deliver({ id: 1, ok: true, reply })).not.toThrow();
  });
});

describe("close", () => {
  it("asks the child to stop, then kills it", () => {
    const child = harness();
    const client = createWorkerClient("/a", child.channel);
    child.deliver({ ready: true });
    client.close();
    expect(child.posted).toEqual([{ id: 0, kind: "close" }]);
    expect(child.killed()).toBe(1);
  });

  it("rejects a search in flight instead of stranding it", async () => {
    // Release while a query is outstanding: the renderer navigated away, and
    // the pool retires the worker underneath a search nobody cancelled.
    const child = harness();
    const client = createWorkerClient("/a", child.channel);
    child.deliver({ ready: true });
    const pending = client.search("a");
    await Promise.resolve();
    client.close();
    await expect(pending).rejects.toThrow("closed");
  });

  it("kills without asking when the child is already gone", () => {
    // Posting to a dead child is at best wasted and at worst a throw from
    // inside `close`, which would skip the kill that follows it.
    const child = harness();
    const client = createWorkerClient("/a", child.channel);
    child.exit("gone");
    client.close();
    expect(child.posted).toEqual([]);
    expect(child.killed()).toBe(1);
  });
});

describe("recording a chosen file", () => {
  it("posts the query and the path without waiting for anything", () => {
    const child = harness();
    const client = createWorkerClient("/a", child.channel);
    child.deliver({ ready: true });
    client.record("fmt", "/a/src/format.ts");
    expect(child.posted).toEqual([
      { id: 0, kind: "record", query: "fmt", chosenPath: "/a/src/format.ts" },
    ]);
  });

  it("drops the record rather than posting it to a child that is gone", () => {
    // Paired with a live worker in the same file, so a `record` that never
    // posted anything could not pass the assertion above.
    const child = harness();
    const client = createWorkerClient("/a", child.channel);
    child.deliver({ ready: true });
    child.exit("gone");
    client.record("fmt", "/a/src/format.ts");
    expect(child.posted).toEqual([]);
  });
});

describe("asking the engine to re-scan", () => {
  it("posts the request without waiting for anything", () => {
    const child = harness();
    const client = createWorkerClient("/a", child.channel);
    child.deliver({ ready: true });
    client.refresh();
    expect(child.posted).toEqual([{ id: 0, kind: "refresh" }]);
  });

  it("drops it rather than posting to a child that is gone", () => {
    // Paired with the live case above, so a `refresh` that never posted could
    // not pass either assertion.
    const child = harness();
    const client = createWorkerClient("/a", child.channel);
    child.deliver({ ready: true });
    child.exit("gone");
    client.refresh();
    expect(child.posted).toEqual([]);
  });
});
