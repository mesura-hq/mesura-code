/**
 * A PUSH stream of the projected thread list for Symmetria Shell; it ignores what peers send.
 * Every peer gets a snapshot on connect, then deltas on the same open connection. Newline-delimited
 * JSON, because QuickShell's `Socket` reads it with only a `SplitParser`.
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
 * Any local process of this user can connect and never read, and Node buffers unflushed writes
 * without bound. Dropping such a peer is cheap: a stream OPENS WITH A SNAPSHOT, so a reconnect is
 * whole at once. A megabyte is far above any real snapshot.
 */
const MAX_PEER_BACKLOG_BYTES = 1024 * 1024;

export type ThreadStreamServer = NodeNet.Server & {
  /** Writes one line to every currently connected peer. Used by the delta path. */
  readonly broadcast: (line: string) => void;
  /**
   * The only way to observe that a departed peer was forgotten: a write to a destroyed socket does
   * not throw or emit synchronously, so watching for an error after a broadcast proves nothing.
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
      // ⚠ DEFENSIVE AND UNTESTED, on purpose: Node always follows `'error'` with `'close'`, whose
      // handler already removes the peer. Reaching this needs a real transmission fault, which a
      // test cannot force reliably; consider deleting this line before adding coverage for it.
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
        // Check the backlog BEFORE the write: `write` returning false only means "above the
        // high-water mark", the ordinary state of a healthy peer mid-flush.
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
