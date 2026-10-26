// @effect-diagnostics nodeBuiltinImport:off - these specs drive the socket as the bind's client
// would, which is the only way to observe what the main process binds and forwards.
/**
 * Entry points: `makeDictationCommandSocket` and `forwardDictationCommand` (also called from
 * `second-instance` in `app/DesktopClerk.ts`). The main window is a recording stand-in for
 * `ElectronWindow`; the socket is a real `node:net` server in a temporary `XDG_RUNTIME_DIR`.
 */
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";

import type { DictationKeybindingCommand } from "@t3tools/contracts";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { DICTATION_COMMAND_LINE_CHANNEL } from "../ipc/channels.ts";
import { dictationCommandLineArguments } from "./dictationCommandLine.ts";
import { forwardDictationCommand } from "./dictationCommandForwarding.ts";
import {
  dictationCommandSocketPath,
  makeDictationCommandSocket,
} from "./dictationCommandSocket.ts";

const SESSION_COMMANDS: ReadonlyArray<DictationKeybindingCommand> = [
  "dictation.mode.clipboard",
  "dictation.mode.inject",
  "dictation.mode.submit",
  "dictation.pause",
  "dictation.restart",
  "dictation.cancel",
];

/** The line a session bind's client writes for `command`. */
const commandLine = (command: DictationKeybindingCommand) =>
  `${dictationCommandLineArguments(command).join(" ")}\n`;

/**
 * An `ElectronWindow` whose main window records what reaches its renderer. `nextSend` resolves
 * on the next `webContents.send`, so a spec awaits the forward instead of sleeping.
 */
function makeRecordingWindow(input: { readonly hasMainWindow?: boolean } = {}) {
  const sends: Array<readonly [channel: string, payload: unknown]> = [];
  const reveals: unknown[] = [];
  let waiting: Array<() => void> = [];
  const window = {
    webContents: {
      send: (channel: string, payload: unknown) => {
        sends.push([channel, payload]);
        const resolvers = waiting;
        waiting = [];
        for (const resolve of resolvers) resolve();
      },
    },
  } as unknown as Electron.BrowserWindow;
  const current = Effect.succeed(
    input.hasMainWindow === false ? Option.none<Electron.BrowserWindow>() : Option.some(window),
  );
  const layer = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected window creation"),
    main: current,
    currentMainOrFirst: current,
    focusedMainOrFirst: current,
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    prepareReveal: () => Effect.succeed(false),
    reveal: (revealed) => Effect.sync(() => void reveals.push(revealed)),
    sendAll: () => Effect.die("dictation commands go to the main window only"),
    destroyAll: Effect.void,
    syncAllAppearance: () => Effect.void,
  });
  const nextSend = () =>
    new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
  return { layer, sends, reveals, nextSend };
}

/** A fresh directory standing in for `XDG_RUNTIME_DIR`, removed with the test's scope. */
const makeRuntimeDir = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mesura-dictation-"))),
  (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
);

/** Connects, writes `chunks` in order, ends, and resolves once the server has closed its side. */
const writeAndClose = (socketPath: string, chunks: ReadonlyArray<string | Uint8Array>) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        const connection = NodeNet.createConnection(socketPath);
        // A server that drops an oversized line may reset the connection; that is its answer.
        connection.on("error", () => resolve());
        connection.on("close", () => resolve());
        connection.on("connect", () => {
          for (const chunk of chunks) connection.write(chunk);
          connection.end();
        });
        connection.resume();
      }),
  );

const exists = (path: string) => NodeFS.existsSync(path);

describe("search unification phase 4 fence: the dictation command socket", () => {
  it("search unification phase 4 AC1: the socket path is per instance under XDG_RUNTIME_DIR, else under userData", () => {
    assert.equal(
      dictationCommandSocketPath({
        env: { XDG_RUNTIME_DIR: "/run/user/1000" },
        pid: 4242,
        userDataPath: "/home/jc/.config/Mesura Code",
      }),
      "/run/user/1000/mesura-dictation-4242.sock",
    );
    assert.equal(
      dictationCommandSocketPath({
        env: {},
        pid: 4242,
        userDataPath: "/home/jc/.config/Mesura Code",
      }),
      "/home/jc/.config/Mesura Code/mesura-dictation-4242.sock",
    );
  });

  it.effect(
    "search unification phase 4 AC1: the socket listens with mode 0600 only while a session exists",
    () =>
      Effect.gen(function* () {
        const runtimeDir = yield* makeRuntimeDir;
        const socketPath = NodePath.join(runtimeDir, "mesura-dictation-4242.sock");
        const window = makeRecordingWindow();
        const socket = yield* makeDictationCommandSocket({ socketPath }).pipe(
          Effect.provide(window.layer),
        );
        assert.isFalse(exists(socketPath), "no socket before the session starts");

        yield* socket.setSessionActive(true);
        const stat = NodeFS.statSync(socketPath);
        assert.isTrue(stat.isSocket());
        assert.equal(stat.mode & 0o777, 0o600);

        yield* socket.setSessionActive(false);
        assert.isFalse(exists(socketPath), "the session end removes the socket");

        // A second session binds the same path again.
        yield* socket.setSessionActive(true);
        assert.isTrue(NodeFS.statSync(socketPath).isSocket());
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "search unification phase 4 AC1: closing the app during a session removes the socket",
    () =>
      Effect.gen(function* () {
        const runtimeDir = yield* makeRuntimeDir;
        const socketPath = NodePath.join(runtimeDir, "mesura-dictation-4242.sock");
        const window = makeRecordingWindow();
        // The inner scope is the application's: it closes when the app exits.
        yield* Effect.gen(function* () {
          const socket = yield* makeDictationCommandSocket({ socketPath }).pipe(
            Effect.provide(window.layer),
          );
          yield* socket.setSessionActive(true);
          assert.isTrue(exists(socketPath));
        }).pipe(Effect.scoped);
        assert.isFalse(exists(socketPath), "app exit removes the socket");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "search unification phase 4 rework P1-1: closing the app while a session socket starts leaves no socket behind",
    () =>
      Effect.gen(function* () {
        const runtimeDir = yield* makeRuntimeDir;
        const socketPath = NodePath.join(runtimeDir, "mesura-dictation-4242.sock");
        const window = makeRecordingWindow();
        const starting = yield* Effect.gen(function* () {
          const socket = yield* makeDictationCommandSocket({ socketPath }).pipe(
            Effect.provide(window.layer),
          );
          // The start is still running when the application's scope closes.
          return yield* Effect.forkDetach(socket.setSessionActive(true));
        }).pipe(Effect.scoped);
        yield* Fiber.join(starting);
        assert.isFalse(exists(socketPath), "app exit removes a socket that was still starting");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "search unification phase 4 AC1: a stale file a killed instance left at the path does not stop the session socket",
    () =>
      Effect.gen(function* () {
        const runtimeDir = yield* makeRuntimeDir;
        const socketPath = NodePath.join(runtimeDir, "mesura-dictation-4242.sock");
        NodeFS.writeFileSync(socketPath, "left behind");
        const window = makeRecordingWindow();
        const socket = yield* makeDictationCommandSocket({ socketPath }).pipe(
          Effect.provide(window.layer),
        );
        yield* socket.setSessionActive(true);
        assert.isTrue(NodeFS.statSync(socketPath).isSocket());

        const forwarded = window.nextSend();
        yield* writeAndClose(socketPath, [commandLine("dictation.cancel")]);
        yield* Effect.promise(() => forwarded);
        assert.deepEqual(window.sends, [[DICTATION_COMMAND_LINE_CHANNEL, "dictation.cancel"]]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "search unification phase 4 AC2: each session key's command line reaches the renderer on the second-instance channel",
    () =>
      Effect.gen(function* () {
        const runtimeDir = yield* makeRuntimeDir;
        const socketPath = NodePath.join(runtimeDir, "mesura-dictation-4242.sock");
        const window = makeRecordingWindow();
        const socket = yield* makeDictationCommandSocket({ socketPath }).pipe(
          Effect.provide(window.layer),
        );
        yield* socket.setSessionActive(true);

        // One connection per key press, as each bind runs its own client.
        for (const command of SESSION_COMMANDS) {
          const forwarded = window.nextSend();
          yield* writeAndClose(socketPath, [commandLine(command)]);
          yield* Effect.promise(() => forwarded);
        }
        assert.deepEqual(
          window.sends,
          SESSION_COMMANDS.map((command) => [DICTATION_COMMAND_LINE_CHANNEL, command]),
        );
        assert.deepEqual(window.reveals, [], "a dictation key never shows the window");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "search unification phase 4 AC3: malformed and unknown lines are ignored and the next command still arrives",
    () =>
      Effect.gen(function* () {
        const runtimeDir = yield* makeRuntimeDir;
        const socketPath = NodePath.join(runtimeDir, "mesura-dictation-4242.sock");
        const window = makeRecordingWindow();
        const socket = yield* makeDictationCommandSocket({ socketPath }).pipe(
          Effect.provide(window.layer),
        );
        yield* socket.setSessionActive(true);

        const forwarded = window.nextSend();
        yield* writeAndClose(socketPath, [
          "hello\n",
          "\n",
          "--dictation\n",
          "--dictation mode bogus\n",
          "--dictation explode\n",
          "https://example.com/not-a-command\n",
          new Uint8Array([0xff, 0xfe, 0x00, 0x0a]),
          `{"command":"dictation.cancel"}\n`,
          // Split across writes: the line is whole only at its newline.
          "--dictation ",
          "pause\n",
        ]);
        yield* Effect.promise(() => forwarded);
        assert.deepEqual(window.sends, [[DICTATION_COMMAND_LINE_CHANNEL, "dictation.pause"]]);
        assert.deepEqual(window.reveals, [], "nothing on the socket shows the window");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "search unification phase 4 AC3: a line over 1 KiB is dropped, and a client gone mid-line does not stop the socket",
    () =>
      Effect.gen(function* () {
        const runtimeDir = yield* makeRuntimeDir;
        const socketPath = NodePath.join(runtimeDir, "mesura-dictation-4242.sock");
        const window = makeRecordingWindow();
        const socket = yield* makeDictationCommandSocket({ socketPath }).pipe(
          Effect.provide(window.layer),
        );
        yield* socket.setSessionActive(true);

        // A valid command at the end of an oversized line is still part of that line.
        yield* writeAndClose(socketPath, [
          `${"x".repeat(2048)} ${commandLine("dictation.cancel")}`,
        ]);
        // A client that disconnects mid-line; `resetAndDestroy` is TCP-only and throws here.
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              const connection = NodeNet.createConnection(socketPath, () => {
                connection.write("--dictation mo");
                connection.destroy();
              });
              connection.on("error", () => resolve());
              connection.on("close", () => resolve());
            }),
        );

        const forwarded = window.nextSend();
        yield* writeAndClose(socketPath, [commandLine("dictation.mode.inject")]);
        yield* Effect.promise(() => forwarded);
        assert.deepEqual(window.sends, [[DICTATION_COMMAND_LINE_CHANNEL, "dictation.mode.inject"]]);
        assert.isTrue(NodeFS.statSync(socketPath).isSocket());
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("search unification phase 4 fence: one dictation forwarding function", () => {
  it.effect(
    "search unification phase 4 AC6: a dictation argv is forwarded to the main window without revealing it",
    () =>
      Effect.gen(function* () {
        const window = makeRecordingWindow();
        const handled = yield* forwardDictationCommand([
          "/opt/mesura-code/mesura-code",
          "--dictation",
          "mode",
          "inject",
        ]).pipe(Effect.provide(window.layer));
        assert.isTrue(handled);
        assert.deepEqual(window.sends, [[DICTATION_COMMAND_LINE_CHANNEL, "dictation.mode.inject"]]);
        assert.deepEqual(window.reveals, []);
      }),
  );

  it.effect(
    "search unification phase 4 AC6: an argv without a dictation command is left to the caller",
    () =>
      Effect.gen(function* () {
        const window = makeRecordingWindow();
        for (const argv of [
          ["/opt/mesura-code/mesura-code"],
          ["/opt/mesura-code/mesura-code", "--dictation", "explode"],
          ["/opt/mesura-code/mesura-code", "https://app.example/threads/1"],
        ]) {
          const handled = yield* forwardDictationCommand(argv).pipe(Effect.provide(window.layer));
          assert.isFalse(handled, argv.join(" "));
        }
        assert.deepEqual(window.sends, []);
        assert.deepEqual(window.reveals, []);
      }),
  );

  it.effect(
    "search unification phase 4 AC6: a dictation command with no main window is handled and goes nowhere",
    () =>
      Effect.gen(function* () {
        const window = makeRecordingWindow({ hasMainWindow: false });
        const handled = yield* forwardDictationCommand([
          "/opt/mesura-code/mesura-code",
          "--dictation",
          "cancel",
        ]).pipe(Effect.provide(window.layer));
        assert.isTrue(handled);
        assert.deepEqual(window.sends, []);
        assert.deepEqual(window.reveals, []);
      }),
  );

  it("search unification phase 4 AC6: the second-instance handler and the socket both call forwardDictationCommand", () => {
    const source = (relativePath: string) =>
      NodeFS.readFileSync(NodePath.join(import.meta.dirname, relativePath), "utf8");
    const clerk = source("../app/DesktopClerk.ts");
    assert.include(clerk, "forwardDictationCommand(");
    // The parsing moved out with the forwarding; the handler keeps only the call.
    assert.notInclude(clerk, "parseDictationCommandLine");
    assert.notInclude(clerk, "DICTATION_COMMAND_LINE_CHANNEL");
    assert.include(source("./dictationCommandSocket.ts"), "forwardDictationCommand(");
  });
});
