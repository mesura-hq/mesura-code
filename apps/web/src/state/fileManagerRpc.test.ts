import type { FileManagerEvent, FileManagerStreamItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createSessionSinks, followSession } from "./fileManagerRpc";

const changed: FileManagerEvent = {
  channel: "symmetria-fm:changed",
  payload: { subscriptionId: "w" },
};

describe("session sinks", () => {
  it("delivers to the registered sink only, and to nobody after release", () => {
    const sinks = createSessionSinks();
    const a: FileManagerStreamItem[] = [];
    const b: FileManagerStreamItem[] = [];
    sinks.register("a", { onItem: (item) => a.push(item) });
    sinks.register("b", { onItem: (item) => b.push(item) });

    sinks.deliver("a", changed);
    sinks.release("a");
    sinks.deliver("a", changed);
    sinks.deliver("nobody", changed);
    sinks.release("nobody");

    expect(a).toEqual([changed]);
    expect(b).toEqual([]);
    expect(sinks.size).toBe(1);
  });
});

/** A stream the test drives by hand. */
function scriptedStream() {
  let onItem: ((item: FileManagerStreamItem) => void) | null = null;
  let onFailure: ((cause: unknown) => void) | null = null;
  let stops = 0;
  return {
    subscribe: (next: (item: FileManagerStreamItem) => void) => {
      onItem = next;
      return {
        onFailure: (report: (cause: unknown) => void) => {
          onFailure = report;
        },
        stop: () => {
          stops += 1;
        },
      };
    },
    emit: (item: FileManagerStreamItem) => onItem?.(item),
    fail: (cause: unknown) => onFailure?.(cause),
    get stops() {
      return stops;
    },
  };
}

describe("following a session", () => {
  it("settles ready on the marker and forwards the events that follow", async () => {
    const stream = scriptedStream();
    const events: FileManagerEvent[] = [];
    const session = followSession(
      stream.subscribe,
      (event) => events.push(event),
      () => undefined,
    );

    stream.emit({ ready: true });
    await session.ready;
    stream.emit(changed);

    expect(events).toEqual([changed]);
    session.stop();
    expect(stream.stops).toBe(1);
  });

  it("rejects ready when the stream fails before the marker", async () => {
    const stream = scriptedStream();
    const lost: unknown[] = [];
    const session = followSession(
      stream.subscribe,
      () => undefined,
      (cause) => lost.push(cause),
    );

    stream.fail(new Error("not authorised"));

    await expect(session.ready).rejects.toThrow("not authorised");
    expect(lost).toEqual([]);
  });

  it("reports a loss through onLost once the session had opened", async () => {
    const stream = scriptedStream();
    const lost: unknown[] = [];
    const session = followSession(
      stream.subscribe,
      () => undefined,
      (cause) => lost.push(cause),
    );

    stream.emit({ ready: true });
    await session.ready;
    stream.fail("socket closed");

    expect(lost).toEqual(["socket closed"]);
  });
});

describe("watching an atom", () => {
  it("computes the atom on subscribe, so a runtime atom's effect starts", async () => {
    const { Atom, AtomRegistry } = await import("effect/unstable/reactivity");
    const { watchAtom } = await import("./fileManagerRpc");
    let computed = 0;
    const atom = Atom.make(() => {
      computed += 1;
      return computed;
    });
    const registry = AtomRegistry.make();
    const seen: number[] = [];
    // A plain subscription asks only to be told of changes; nothing runs.
    const plain = registry.subscribe(atom, (value) => seen.push(value));
    expect(computed).toBe(0);
    plain();
    const stop = watchAtom(registry, atom, (value) => seen.push(value));
    expect(computed).toBe(1);
    expect(seen).toEqual([1]);
    stop();
  });
});
