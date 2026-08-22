/**
 * The Unix socket Symmetria Shell reads the projected thread list from.
 *
 * A PUSH stream, which is what makes it a different server from the dictation
 * one next door rather than a second use of it: dictation is one line in, one
 * line out on the same connection, and this writes without being asked. Only
 * the binding is shared, in `unixSocket.ts`.
 *
 * The framing is the contract's: **a stream opens with a snapshot**, so every
 * peer receives one the moment it connects and never has to reason about what
 * it missed. Deltas come later; the connection is deliberately held open for
 * them rather than closed after the snapshot.
 *
 * Newline-delimited JSON, one item per line, because that is what the consumer
 * can read with no dependency: QuickShell's `Socket` carries a `SplitParser`
 * and nothing else.
 *
 * Only `node:net` here — the filesystem side is `socketFiles.ts` and the
 * projection is `threadProjection.ts`, each testable in its own idiom.
 */
import * as NodeNet from "node:net";

import { SymmetriaStreamSnapshot } from "@symmetria/broker-contract";

/**
 * The ENCODED snapshot — plain JSON, no brands. What a producer builds and what
 * `JSON.stringify` can write. See the same note in `threadProjection.ts`: the
 * contract's exported type is the decoded form a CONSUMER holds.
 */
type WireSnapshot = typeof SymmetriaStreamSnapshot.Encoded;

export type ThreadStreamOptions = {
  /**
   * The state as it is NOW, asked for once per connection.
   *
   * A function rather than a value because the publisher is built once and
   * lives for the process: a snapshot captured at construction would serve the
   * empty world to every peer forever.
   */
  readonly snapshot: () => WireSnapshot;
  /** Called for anything a socket callback would otherwise swallow. */
  readonly onError?: (error: Error) => void;
};

/**
 * How much unflushed data one peer may accumulate before it is dropped.
 *
 * A peer that connects and never reads is not hypothetical: any local process
 * owned by this user can open the socket, and the shell itself can stall while
 * its event loop is busy. Node buffers whatever `write` cannot flush, with no
 * bound of its own, so without this the delta path would grow the main
 * process's memory once per stalled reader for as long as it stays connected.
 *
 * Dropping is the right answer rather than a harsh one, and the contract is
 * what makes it cheap: a stream OPENS WITH A SNAPSHOT, so a peer that
 * reconnects is immediately whole again. Waiting for `drain` instead would
 * make the publisher hold state on behalf of a consumer that may never return.
 *
 * A megabyte is far above any real snapshot and far below anything that
 * matters to this process.
 */
const MAX_PEER_BACKLOG_BYTES = 1024 * 1024;

export type ThreadStreamServer = NodeNet.Server & {
  /** Writes one line to every currently connected peer. Used by the delta path. */
  readonly broadcast: (line: string) => void;
  /**
   * How many peers are attached right now.
   *
   * Exposed because it is the only way to observe that a departed peer was
   * actually forgotten. Writing to a destroyed socket does NOT throw and does
   * NOT emit synchronously — Node defers the failure to the next tick — so a
   * test that watches for an error after a broadcast is vacuously green
   * whether the cleanup ran or not. That is not hypothetical: it is the exact
   * defect verification found in the first attempt at that test.
   *
   * Useful past the test, too: "n peers attached" is what a log line wants.
   */
  readonly peerCount: () => number;
};

export function createThreadStreamServer(options: ThreadStreamOptions): ThreadStreamServer {
  const { snapshot, onError } = options;
  const peers = new Set<NodeNet.Socket>();

  const server = NodeNet.createServer((connection) => {
    peers.add(connection);
    connection.setEncoding("utf8");

    // A peer that goes away mid-write raises EPIPE/ECONNRESET on the socket.
    // Unhandled, that reaches the process rather than this connection, so a
    // shell restarting would take the publisher down with it.
    connection.on("error", (error) => {
      // ⚠ This `delete` is DEFENSIVE AND UNTESTED, and both halves of that are
      // deliberate rather than an oversight. Node destroys a socket that emits
      // `'error'` and always follows it with `'close'`, so the handler below
      // already removes the peer — this line is a duplicate of a cleanup that
      // cannot fail to run.
      //
      // No test drives it, and verification established why rather than
      // leaving it as a gap of unknown shape: a client-side `.destroy()`
      // produces a clean `'close'` on the server, never an `'error'`, so
      // reaching this branch needs a real transmission fault. Forcing one is
      // fiddly and flaky. Whoever wants the coverage should first ask whether
      // to delete the line instead — one cleanup path is better than two, and
      // the remaining one IS covered.
      peers.delete(connection);
      onError?.(error);
    });
    connection.on("close", () => peers.delete(connection));

    // A peer that sends anything is ignored on purpose. This direction is
    // read-only by design; the command envelope the contract describes is a
    // separate decision and a separate socket when it arrives.
    connection.resume();

    try {
      connection.write(`${JSON.stringify(snapshot())}\n`);
    } catch (cause) {
      onError?.(cause instanceof Error ? cause : new Error(String(cause)));
      peers.delete(connection);
      connection.destroy();
    }
  }) as ThreadStreamServer;

  return Object.assign(server, {
    peerCount: (): number => peers.size,
    broadcast: (line: string): void => {
      for (const peer of peers) {
        // Checked BEFORE the write, not after: `write` returning false means
        // "above the high-water mark", which is the ordinary state of a
        // healthy peer mid-flush and says nothing about whether it is stuck.
        // The backlog that has actually accumulated is what distinguishes the
        // two.
        if (peer.writableLength > MAX_PEER_BACKLOG_BYTES) {
          peers.delete(peer);
          onError?.(
            new Error(
              `dropping a peer with ${peer.writableLength} bytes unflushed: it is not reading`,
            ),
          );
          peer.destroy();
          continue;
        }
        try {
          peer.write(`${line}\n`);
        } catch (cause) {
          onError?.(cause instanceof Error ? cause : new Error(String(cause)));
          peers.delete(peer);
        }
      }
    },
  });
}
