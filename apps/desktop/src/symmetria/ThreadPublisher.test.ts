// @effect-diagnostics nodeBuiltinImport:off - this drives the socket as a peer
// would, which is the only way to observe what the publisher actually binds.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { SymmetriaStreamItem } from "@symmetria/broker-contract";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";

import { PUBLISH_THREADS_CHANNEL } from "../ipc/channels.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as ThreadPublisher from "./ThreadPublisher.ts";

const decodeStreamLine = Schema.decodeUnknownSync(Schema.fromJsonString(SymmetriaStreamItem));

/** An `ipcMain` stand-in that records which invoke channels were registered. */
const makeRecordingIpcMain = () => {
  const handledChannels = new Set<string>();
  const ipcMain: DesktopIpc.DesktopIpcMain = {
    removeHandler: (channel) => {
      handledChannels.delete(channel);
    },
    handle: (channel) => {
      handledChannels.add(channel);
    },
    removeAllListeners: () => {},
    on: () => {},
  };
  return { ipcMain, handledChannels };
};

/** Reads the first line the publisher writes to a fresh peer. */
const readFirstLine = (socketPath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const connection = NodeNet.createConnection(socketPath);
    let received = "";
    connection.setEncoding("utf8");
    connection.on("error", reject);
    connection.on("data", (chunk: string) => {
      received += chunk;
      const newline = received.indexOf("\n");
      if (newline === -1) return;
      connection.end();
      resolve(received.slice(0, newline));
    });
  });

// Guard for the removal of Shell's dictation link: the thread feed is the one
// Symmetria socket that stays, so the publisher must still bind its own path
// and register its push channel once the dictation layers are gone.
it.effect("ThreadPublisher still binds the Symmetria thread socket and its push channel", () =>
  Effect.gen(function* () {
    const runtimeDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mesura-threads-"));
    const previousRuntimeDir = process.env["XDG_RUNTIME_DIR"];
    process.env["XDG_RUNTIME_DIR"] = runtimeDir;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (previousRuntimeDir === undefined) delete process.env["XDG_RUNTIME_DIR"];
        else process.env["XDG_RUNTIME_DIR"] = previousRuntimeDir;
        NodeFS.rmSync(runtimeDir, { recursive: true, force: true });
      }),
    );

    const { ipcMain, handledChannels } = makeRecordingIpcMain();
    const publisher = yield* ThreadPublisher.make.pipe(
      Effect.provideService(DesktopIpc.DesktopIpc, DesktopIpc.make(ipcMain)),
    );

    const expectedPath = NodePath.join(runtimeDir, `symmetria-mesura-threads-${process.pid}.sock`);
    assert.deepEqual(publisher.socketPath, Option.some(expectedPath));
    assert.isTrue(NodeFS.statSync(expectedPath).isSocket());
    assert.isTrue(handledChannels.has(PUBLISH_THREADS_CHANNEL));

    const firstLine = yield* Effect.promise(() => readFirstLine(expectedPath));
    assert.equal(decodeStreamLine(firstLine).type, "snapshot");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
