// @effect-diagnostics nodeBuiltinImport:off -- drives a real Unix socket and shell, as a Hyprland bind does.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import type { DictationKeybindingCommand } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  dictationSocketCommand,
  listenForDictationCommands,
  parseDictationSocketLine,
  resolveDictationSocketPath,
} from "./dictationControlSocket.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const hasSocat = (() => {
  try {
    NodeChildProcess.execFileSync("socat", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("resolveDictationSocketPath", () => {
  const base = { userDataPath: "/home/u/.config/Mesura", uid: 1000, tmpDir: "/tmp" };

  it("gives the default packaged instance a stable path a hand-written bind can name", () => {
    expect(
      resolveDictationSocketPath({
        ...base,
        env: { XDG_RUNTIME_DIR: "/run/user/1000" },
        isDevelopment: false,
      }),
    ).toBe("/run/user/1000/mesura-code/dictation.sock");
  });

  it("gives development and XDG_CONFIG_HOME-isolated instances their own socket per userData", () => {
    const dev = resolveDictationSocketPath({
      ...base,
      env: { XDG_RUNTIME_DIR: "/run/user/1000" },
      isDevelopment: true,
    });
    const isolatedA = resolveDictationSocketPath({
      ...base,
      userDataPath: "/state/a/Mesura",
      env: { XDG_RUNTIME_DIR: "/run/user/1000", XDG_CONFIG_HOME: "/state/a" },
      isDevelopment: false,
    });
    const isolatedB = resolveDictationSocketPath({
      ...base,
      userDataPath: "/state/b/Mesura",
      env: { XDG_RUNTIME_DIR: "/run/user/1000", XDG_CONFIG_HOME: "/state/b" },
      isDevelopment: false,
    });
    for (const path of [dev, isolatedA, isolatedB]) {
      expect(path).toMatch(/^\/run\/user\/1000\/mesura-code\/dictation-[0-9a-f]{12}\.sock$/);
    }
    expect(new Set([dev, isolatedA, isolatedB]).size).toBe(3);
  });

  it("falls back to a per-user directory under tmp without XDG_RUNTIME_DIR", () => {
    expect(resolveDictationSocketPath({ ...base, env: {}, isDevelopment: false })).toBe(
      "/tmp/mesura-code-1000/dictation.sock",
    );
  });
});

describe("parseDictationSocketLine", () => {
  it("reads the words after --dictation", () => {
    expect(parseDictationSocketLine("toggle")).toBe("dictation.toggle");
    expect(parseDictationSocketLine("  mode inject \r")).toBe("dictation.mode.inject");
  });

  it("rejects anything that is not a dictation command", () => {
    for (const line of ["", "mode", "mode everything", "rm -rf /", "toggle-everything"]) {
      expect(parseDictationSocketLine(line)).toBeNull();
    }
  });
});

describe("listenForDictationCommands", () => {
  let directory: string;
  let socketPath: string;
  let received: DictationKeybindingCommand[];
  let close: () => void;

  const listen = async () => {
    const socket = listenForDictationCommands({
      socketPath,
      onCommand: (command) => received.push(command),
      onError: (cause) => {
        throw cause;
      },
    });
    close = socket.close;
    await socket.ready;
  };

  /** Sends raw bytes and resolves once the server has closed the connection. */
  const send = (bytes: string) =>
    new Promise<void>((resolve, reject) => {
      const client = NodeNet.createConnection(socketPath, () => client.end(bytes));
      client.on("close", () => resolve());
      client.on("error", reject);
      client.resume();
    });

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dictation-socket-"));
    socketPath = NodePath.join(directory, "run", "dictation.sock");
    received = [];
    close = () => undefined;
  });

  afterEach(() => {
    close();
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("takes one command per connection, in a private directory, and removes the socket on close", async () => {
    await listen();
    expect(NodeFS.statSync(NodePath.dirname(socketPath)).mode & 0o777).toBe(0o700);
    expect(NodeFS.statSync(socketPath).mode & 0o777).toBe(0o600);

    await send("toggle\n");
    await send("mode submit");
    await send("not a command\n");
    expect(received).toEqual(["dictation.toggle", "dictation.mode.submit"]);

    close();
    expect(NodeFS.existsSync(socketPath)).toBe(false);
  });

  it("drops a connection that sends more than a command line", async () => {
    await listen();
    await send(`toggle ${"x".repeat(1024)}\n`);
    expect(received).toEqual([]);
  });

  it("replaces a socket file a crashed instance left behind", async () => {
    NodeFS.mkdirSync(NodePath.dirname(socketPath), { recursive: true });
    NodeFS.writeFileSync(socketPath, "");
    await listen();
    await send("cancel\n");
    expect(received).toEqual(["dictation.cancel"]);
  });

  it.skipIf(!hasSocat)(
    "the bind's shell command reaches the running instance without the second launch",
    async () => {
      await listen();
      const marker = NodePath.join(directory, "fallback-ran");
      const command = dictationSocketCommand({
        socketPath,
        launcher: ["sh", "-c", `touch "${marker}"`, "fallback"],
        command: "dictation.mode.inject",
      });
      await execFile("sh", ["-c", command]);
      expect(received).toEqual(["dictation.mode.inject"]);
      expect(NodeFS.existsSync(marker)).toBe(false);
    },
  );

  it.skipIf(!hasSocat)(
    "the bind's shell command runs the second launch when nothing listens",
    async () => {
      const marker = NodePath.join(directory, "fallback-ran");
      const command = dictationSocketCommand({
        socketPath,
        launcher: ["sh", "-c", `touch "${marker}"`, "fallback"],
        command: "dictation.toggle",
      });
      await execFile("sh", ["-c", command]);
      expect(NodeFS.existsSync(marker)).toBe(true);
    },
  );
});
