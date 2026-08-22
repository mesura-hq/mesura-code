// @effect-diagnostics nodeBuiltinImport:off - this drives the socket as a peer
// would, which is the only way to observe what a consumer actually receives.
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { SymmetriaStreamItem } from "@symmetria/broker-contract";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createThreadStreamServer } from "./threadStream.ts";
import { closeServer, listenOnPath } from "./unixSocket.ts";

const decodeStreamItem = Schema.decodeUnknownResult(SymmetriaStreamItem);

// The ENCODED shape, which is what a producer builds and what travels. The
// contract's exported type is the decoded one, whose identifiers are branded.
type WireSnapshot = typeof SymmetriaStreamItem.Encoded & { readonly type: "snapshot" };

const SNAPSHOT = {
  type: "snapshot",
  protocolVersion: { major: 1, minor: 1 },
  revision: 7,
  threads: [],
  surfaces: [],
  drafts: [],
  projects: [{ projectId: "prj_vigilia", name: "vigilia" }],
} as WireSnapshot;

const servers: NodeNet.Server[] = [];

afterEach(async () => {
  while (servers.length > 0) await closeServer(servers.pop() as NodeNet.Server);
});

const socketPath = (name: string): string =>
  NodePath.join(NodeOS.tmpdir(), `symmetria-threadstream-${process.pid}-${name}.sock`);

/** Reads whatever the peer sends until it closes, as one string. */
const readAll = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const connection = NodeNet.createConnection(path);
    let received = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk: string) => {
      received += chunk;
    });
    connection.on("error", reject);
    connection.on("close", () => resolve(received));
    // The publisher holds the connection open for the deltas a later phase
    // will push, so a reader that waited for the server to close would hang.
    // One line is the whole of a snapshot, so close as soon as one arrives.
    connection.on("data", () => {
      if (received.includes("\n")) connection.end();
    });
  });

describe("createThreadStreamServer", () => {
  it("writes one snapshot line to a peer that connects", async () => {
    const path = socketPath("one");
    const server = createThreadStreamServer({ snapshot: () => SNAPSHOT });
    servers.push(server);
    await listenOnPath(server, path);

    const received = await readAll(path);

    const lines = received.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    const decoded = decodeStreamItem(JSON.parse(lines[0] as string));
    if (Result.isFailure(decoded)) throw new Error("peer received something not a stream item");
    expect(decoded.success.type).toBe("snapshot");
  });

  it("gives a second peer its own snapshot while the first is still connected", async () => {
    // Two IDE windows, or a shell that reconnected without the old connection
    // having been reaped yet. A snapshot per connection is what makes each of
    // them start from a state rather than from whatever is next on the wire.
    const path = socketPath("two");
    const server = createThreadStreamServer({ snapshot: () => SNAPSHOT });
    servers.push(server);
    await listenOnPath(server, path);

    const first = NodeNet.createConnection(path);
    first.setEncoding("utf8");
    const firstLine = await new Promise<string>((resolve) => {
      first.on("data", (chunk: string) => resolve(chunk));
    });

    const secondLine = await readAll(path);

    expect(firstLine.trim().length).toBeGreaterThan(0);
    expect(JSON.parse(secondLine.trim())).toEqual(JSON.parse(firstLine.trim()));
    first.end();
  });

  it("asks for the snapshot at connect time, not at construction time", async () => {
    // The publisher is built once and lives for the process. A snapshot
    // captured at construction would serve the empty world forever.
    const path = socketPath("fresh");
    let revision = 1;
    const server = createThreadStreamServer({
      snapshot: () => ({ ...SNAPSHOT, revision: revision++ }),
    });
    servers.push(server);
    await listenOnPath(server, path);

    const first = JSON.parse((await readAll(path)).trim()) as { revision: number };
    const second = JSON.parse((await readAll(path)).trim()) as { revision: number };

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
  });

  it("keeps serving after a peer disconnects abruptly", async () => {
    // A shell restarting is the ordinary case. What is observable from outside
    // is that the server still serves — the previous version of this test
    // collected `onError` calls and asserted nothing about them, which review
    // caught: it would have passed with the whole error branch deleted.
    const path = socketPath("rude");
    const server = createThreadStreamServer({ snapshot: () => SNAPSHOT });
    servers.push(server);
    await listenOnPath(server, path);

    const rude = NodeNet.createConnection(path);
    rude.on("error", () => {});
    await new Promise<void>((resolve) => {
      rude.on("close", () => resolve());
      rude.on("connect", () => rude.destroy());
    });

    const received = await readAll(path);
    expect(received.trim().length).toBeGreaterThan(0);
  });

  it("forgets a peer that has gone", async () => {
    // ⚠ Asserted through `peerCount`, and the first two attempts at this test
    // were both wrong in the same way. Writing to a destroyed socket neither
    // throws nor emits synchronously — Node defers the failure a tick — so
    // "broadcast and then check no error arrived" is vacuously true whether or
    // not the peer was ever removed. Verification proved it by deleting the
    // cleanup and watching the test stay green. The set's size is the only
    // thing that actually moves.
    const path = socketPath("forget");
    const server = createThreadStreamServer({ snapshot: () => SNAPSHOT });
    servers.push(server);
    await listenOnPath(server, path);

    const peer = NodeNet.createConnection(path);
    peer.on("error", () => {});
    await new Promise<void>((resolve) => peer.on("data", () => resolve()));
    expect(server.peerCount()).toBe(1);

    await new Promise<void>((resolve) => {
      peer.on("close", () => resolve());
      peer.destroy();
    });
    // The server learns of the close on its own turn of the event loop. One
    // round trip through a fresh connection gives it that turn without a
    // wall-clock sleep, which would be both flaky and forbidden here.
    await readAll(path);

    expect(server.peerCount()).toBe(0);
  });

  it("drops a peer that stops reading instead of buffering for it forever", async () => {
    // The delta path calls `broadcast` for the life of the process. Without a
    // bound, one stalled reader grows the main process's memory without limit.
    // Dropping is cheap because the contract opens every stream with a
    // snapshot: a peer that reconnects is whole again immediately.
    const path = socketPath("stalled");
    const errors: Error[] = [];
    const server = createThreadStreamServer({
      snapshot: () => SNAPSHOT,
      onError: (error) => errors.push(error),
    });
    servers.push(server);
    await listenOnPath(server, path);

    // Connect and never read: `pause()` stops the flow so the kernel buffer
    // and then Node's own buffer fill up.
    const stalled = NodeNet.createConnection(path);
    stalled.on("error", () => {});
    await new Promise<void>((resolve) => stalled.on("connect", () => resolve()));
    stalled.pause();

    const fat = "x".repeat(256 * 1024);
    let closed = false;
    stalled.on("close", () => {
      closed = true;
    });
    for (let attempt = 0; attempt < 200 && !closed; attempt += 1) {
      server.broadcast(fat);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(errors.some((error) => /not reading/.test(error.message))).toBe(true);
  });
});
