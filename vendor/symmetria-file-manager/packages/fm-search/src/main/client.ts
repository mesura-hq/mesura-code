/**
 * The parent's half of the worker protocol.
 *
 * `worker.ts` is the child's half and takes a `WorkerTransport` so the same
 * logic runs under Electron and under a plain Node fork. This is the mirror of
 * that, and it exists for the same reason: the lifetime rules — readiness,
 * reply correlation, what happens when the child dies — are the part worth
 * testing, and they must not live inside a module that imports `electron`.
 *
 * **Every pending search must settle.** A reply is matched to its request by
 * id, so a child that dies leaves resolvers in the map with nothing to answer
 * them. The renderer's `invoke` waits on that promise forever: not a crash, not
 * an error message, just a finder that never draws. `abandon` is the single
 * path from "the child is gone" to "every waiting caller learns why", and every
 * way the child can go — a crash, a failed index, a deliberate close — routes
 * through it.
 *
 * **Readiness is a promise, not a flag.** Opening an index is slow and can
 * fail, and a caller that cannot tell "still scanning" from "never opened"
 * reads an empty result as "no matches".
 */
import type { IndexWorker, SearchReply } from "./pool.ts";
import type { WorkerMessage, WorkerRequest } from "./worker.ts";

/** What the client needs from a live child, whoever spawned it. */
export interface WorkerChannel {
  post(request: WorkerRequest): void;
  onMessage(handler: (message: WorkerMessage) => void): void;
  /** Called once when the child is gone, whatever took it. */
  onExit(handler: (reason: string) => void): void;
  kill(): void;
}

interface Pending {
  readonly resolve: (reply: SearchReply) => void;
  readonly reject: (cause: Error) => void;
}

export function createWorkerClient(directory: string, channel: WorkerChannel): IndexWorker {
  const waiting = new Map<number, Pending>();
  let nextId = 1;
  /** Why the child is gone, once it is. Undefined while it is alive. */
  let gone: string | undefined;

  // Assigned by the executor, which runs synchronously — the no-op defaults are
  // never the ones called. Written this way rather than with a definite
  // assignment so no assertion is needed.
  let announceReady: () => void = () => {};
  let announceNeverReady: (reason: string) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    announceReady = resolve;
    announceNeverReady = (reason) => reject(new Error(reason));
  });
  // A rejection nobody awaited is an unhandled rejection, and in the main
  // process that is a warning on the daemon's journal for a case the pool
  // already handles. Attaching a handler marks it handled; the promise this
  // returns is discarded, and `ready` still rejects for real awaiters.
  void ready.catch(() => {});

  function abandon(reason: string): void {
    if (gone !== undefined) return;
    gone = reason;
    // A no-op when the index did open: a promise settles once.
    announceNeverReady(reason);
    const orphaned = [...waiting.values()];
    waiting.clear();
    for (const pending of orphaned) pending.reject(new Error(reason));
  }

  channel.onMessage((message) => {
    if ("ready" in message) {
      if (message.ready) announceReady();
      else abandon(message.reason);
      return;
    }
    const pending = waiting.get(message.id);
    if (pending === undefined) return;
    waiting.delete(message.id);
    if (message.ok) pending.resolve(message.reply);
    else pending.reject(new Error(message.reason));
  });

  channel.onExit(abandon);

  return {
    directory,
    ready,
    async search(query: string): Promise<SearchReply> {
      // Waiting on readiness is what turns "the index failed to open" into a
      // rejection the renderer can show, instead of a message posted to a dead
      // process and a promise that never settles.
      await ready;
      if (gone !== undefined) throw new Error(gone);
      const id = nextId++;
      return new Promise<SearchReply>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        channel.post({ id, kind: "search", query });
      });
    },
    refresh(): void {
      if (gone !== undefined) return;
      channel.post({ id: 0, kind: "refresh" });
    },
    record(query: string, chosenPath: string): void {
      // Dropped rather than queued when the child is gone. The whole point of
      // this write is that nothing depends on it, so holding it against a
      // process that may never come back would be a leak in aid of nothing.
      if (gone !== undefined) return;
      channel.post({ id: 0, kind: "record", query, chosenPath });
    },
    close(): void {
      // Asked politely, then killed. A worker mid-scan will not answer a
      // message, and an unanswered close is a process that never exits.
      try {
        if (gone === undefined) channel.post({ id: 0, kind: "close" });
      } finally {
        abandon("the search index was closed");
        channel.kill();
      }
    },
  };
}
