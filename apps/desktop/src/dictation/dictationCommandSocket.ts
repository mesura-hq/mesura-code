// @effect-diagnostics nodeBuiltinImport:off -- `node:net` has no Effect service, and the path is
// pure string resolution for a bind line.
/**
 * The dictation session's command socket: while a session exists, the Hyprland session binds
 * write one line per key press here instead of launching a second app process, which the
 * single-instance lock then has to hand back to this one (a 250-340 ms Electron start).
 *
 * A line holds the words `dictationCommandLineArguments` gives for the command, the same ones a
 * `--dictation …` launch carries, so `forwardDictationCommand` serves both paths. Anything that
 * does not parse is dropped: the socket is owner-only, but whatever reaches it must never take
 * the main process down.
 *
 * The filesystem and listener helpers are the Symmetria thread socket's, which have no
 * knowledge of what travels over them.
 */
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import {
  prepareSocketPath,
  removeSocketPath,
  restrictSocketPath,
} from "../symmetria/socketFiles.ts";
import { closeServer, listenOnPath } from "../symmetria/unixSocket.ts";
import { forwardDictationCommand } from "./dictationCommandForwarding.ts";

const { logInfo, logWarning } = makeComponentLogger("dictation-command-socket");

/** A command line is a few words; anything longer is not one. */
const MAX_LINE_BYTES = 1024;

const NEWLINE = 0x0a;

/**
 * Per instance, so two Mesura instances (a side-by-side test install, for one) never share it.
 * `$XDG_RUNTIME_DIR` is owner-only already; the userData directory is the fallback when the
 * session manager provides none.
 */
export function dictationCommandSocketPath(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly pid: number;
  readonly userDataPath: string;
}): string {
  const runtimeDir = input.env.XDG_RUNTIME_DIR?.trim() || input.userDataPath;
  return NodePath.join(runtimeDir, `mesura-dictation-${input.pid}.sock`);
}

/** Calls `onLine` for each newline-terminated line; a line past the cap ends the connection. */
function readLines(connection: NodeNet.Socket, onLine: (line: string) => void): void {
  let pending = new Uint8Array(0);
  const decoder = new TextDecoder();
  connection.on("data", (chunk: Uint8Array) => {
    const joined = new Uint8Array(pending.length + chunk.length);
    joined.set(pending);
    joined.set(chunk, pending.length);
    pending = joined;
    for (let newline = pending.indexOf(NEWLINE); newline >= 0; newline = pending.indexOf(NEWLINE)) {
      const line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (line.length <= MAX_LINE_BYTES) onLine(decoder.decode(line));
    }
    if (pending.length > MAX_LINE_BYTES) connection.destroy();
  });
}

export const makeDictationCommandSocket = Effect.fn("desktop.dictation.makeCommandSocket")(
  function* (input: { readonly socketPath: string }) {
    const { socketPath } = input;
    const context = yield* Effect.context<
      ElectronWindow.ElectronWindow | FileSystem.FileSystem | Path.Path
    >();
    const runFork = Effect.runForkWith(context);
    const mutex = yield* Semaphore.make(1);
    // Forked now, so the app's scope closes every session at the place this socket was made,
    // not at the place a session started.
    const sessions = yield* Scope.fork(yield* Effect.scope);
    /** The running session's scope; closing it closes the listener and removes the node. */
    let session: Scope.Closeable | null = null;
    let closed = false;

    const listen = Effect.gen(function* () {
      yield* prepareSocketPath(socketPath);
      const connections = new Set<NodeNet.Socket>();
      const server = NodeNet.createServer((connection) => {
        connections.add(connection);
        connection.on("close", () => connections.delete(connection));
        // A client that resets is its own problem, not the main process's.
        connection.on("error", () => undefined);
        readLines(connection, (line) => {
          runFork(forwardDictationCommand(line.trim().split(/\s+/)));
        });
      });
      // A `net.Server` emitting 'error' with no listener throws, which would end the app.
      server.on("error", (error) => {
        runFork(logWarning("dictation socket server error", { message: error.message }));
      });
      yield* Effect.acquireRelease(
        Effect.tryPromise(() => listenOnPath(server, socketPath)),
        () =>
          Effect.sync(() => {
            // `close` waits for open connections, and a stuck client must not hold the session.
            for (const connection of connections) connection.destroy();
          }).pipe(
            Effect.andThen(Effect.promise(() => closeServer(server))),
            Effect.andThen(removeSocketPath(socketPath)),
            Effect.orDie,
          ),
      );
      yield* restrictSocketPath(socketPath);
      yield* logInfo("dictation socket listening", { socketPath });
    });

    const start = Effect.gen(function* () {
      if (closed) return false;
      if (session !== null) return true;
      const scope = yield* Scope.fork(sessions);
      const started = yield* listen.pipe(Scope.provide(scope), Effect.exit);
      if (Exit.isSuccess(started)) {
        session = scope;
        return true;
      }
      yield* Scope.close(scope, Exit.void);
      // Best effort: the session binds fall back to the launcher, and the next session
      // tries again.
      yield* logWarning("dictation socket did not start", {
        socketPath,
        cause: String(started.cause),
      });
      return false;
    });

    const stop = Effect.gen(function* () {
      if (session === null) return false;
      const scope = session;
      session = null;
      yield* Scope.close(scope, Exit.void);
      return false;
    });

    // App exit waits for a start still running, stops it, and refuses later ones.
    yield* Effect.addFinalizer(() =>
      mutex.withPermits(1)(
        Effect.suspend(() => {
          closed = true;
          return stop;
        }),
      ),
    );

    return {
      /** Starts or stops the listener; tells whether it listens afterwards. */
      setSessionActive: (active: boolean): Effect.Effect<boolean> =>
        mutex
          .withPermits(1)(active ? start : stop)
          .pipe(Effect.provideContext(context)),
    };
  },
);
