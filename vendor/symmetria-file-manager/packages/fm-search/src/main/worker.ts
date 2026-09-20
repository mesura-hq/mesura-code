/**
 * The process that owns exactly one search index.
 *
 * One index per process is the whole point: the store refuses a second open
 * inside one program, so isolation has to be a process boundary rather than an
 * object boundary. This module is what runs on the far side of it.
 *
 * **The protocol is deliberately tiny** — a request carries an id and a query,
 * a reply carries the same id and either rows or an error. The id is what lets
 * the caller match a reply to its request, since replies can overtake each
 * other under a fast typist.
 *
 * **`serve` takes a transport rather than reading one**, so the same logic runs
 * under Electron's `utilityProcess` (which gives the child a `parentPort`) and
 * under a plain Node fork (which gives it `process.send`). The tests use the
 * second, because two real processes is the only honest way to prove the
 * topology.
 */
import { createIndex, type SearchIndex } from "./index.ts";
import { MAX_RESULTS, type SearchReply } from "./pool.ts";

export interface WorkerRequest {
  readonly id: number;
  readonly kind: "search" | "close" | "record" | "refresh";
  readonly query?: string;
  /** The file a `record` request is attributing to its query. */
  readonly chosenPath?: string;
}

export type WorkerMessage =
  | { readonly id: number; readonly ok: true; readonly reply: SearchReply }
  | { readonly id: number; readonly ok: false; readonly reason: string }
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: string };

export interface WorkerTransport {
  send(message: WorkerMessage): void;
  onMessage(handler: (request: WorkerRequest) => void): void;
  close(): void;
}

/**
 * Own one index over `directory` and answer requests on `transport`.
 *
 * Announces readiness — or the reason it never got there — before accepting a
 * single request. A caller that searches an index which failed to open would
 * otherwise read an empty result as "no matches".
 */
export async function serve(directory: string, transport: WorkerTransport): Promise<void> {
  let index: SearchIndex;
  try {
    index = await createIndex(directory);
  } catch (cause) {
    transport.send({
      ready: false,
      reason: cause instanceof Error ? cause.message : String(cause),
    });
    transport.close();
    return;
  }
  // The listener goes on BEFORE readiness is announced. The parent cannot in
  // fact reply within this synchronous block, so nothing is lost either way —
  // but the two transports are not proven to buffer alike, and an ordering
  // whose safety depends on that is one nobody should have to re-derive.
  transport.onMessage((request) => {
    if (request.kind === "close") {
      index.close();
      transport.close();
      return;
    }
    if (request.kind === "refresh") {
      // No reply, like `record`. The caller is opening a finder and cannot wait
      // on a filesystem walk, and there is no outcome it could act on.
      index.refresh();
      return;
    }
    if (request.kind === "record") {
      // No reply, by design. Nothing waits on this and nothing can repair a
      // failed tracker write, so an id to correlate would be ceremony around a
      // statistic.
      index.record(request.query ?? "", request.chosenPath ?? "");
      return;
    }
    const query = request.query ?? "";
    try {
      const all = index.search(query);
      transport.send({
        id: request.id,
        ok: true,
        reply: {
          rows: all.slice(0, MAX_RESULTS),
          // The query is echoed from the REQUEST, so the caller can discard a
          // reply the user has already typed past.
          matchedQuery: query,
          truncated: all.length > MAX_RESULTS,
          cap: MAX_RESULTS,
        },
      });
    } catch (cause) {
      transport.send({
        id: request.id,
        ok: false,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  });

  transport.send({ ready: true });
}

/** The transport a plain Node fork gives its child. */
export function nodeChildTransport(): WorkerTransport {
  return {
    send: (message) => process.send?.(message),
    // SAFETY: widens the handler's parameter so `process.on` accepts it. The
    // only writer on a fork's channel is the parent that forked it, and
    // `createWorkerClient` posts nothing but a `WorkerRequest`.
    onMessage: (handler) => process.on("message", handler as (value: unknown) => void),
    close: () => process.exit(0),
  };
}
