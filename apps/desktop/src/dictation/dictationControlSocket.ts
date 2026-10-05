// @effect-diagnostics nodeBuiltinImport:off -- a Unix socket is the native boundary a Hyprland bind reaches.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { DictationKeybindingCommand } from "@t3tools/contracts";

import {
  DICTATION_FLAG,
  dictationCommandLineArguments,
  parseDictationCommandLine,
} from "./dictationCommandLine.ts";

/**
 * The fast way into a running instance's dictation. A second launch of the app hands
 * `--dictation …` over through the single-instance lock, but it has to boot Electron (and,
 * packaged, mount the AppImage) first: 2-3.5 s per key press on the laptop, measured
 * 2026-10-05. A bind that writes the command words to this socket with `socat` lands in a few
 * milliseconds. The second launch stays as the bind's fallback, for when the socket is missing.
 *
 * The protocol is one line, the words after `--dictation` (`toggle`, `mode inject`).
 */

/** The socket of the default packaged instance: the path a hand-written Hyprland bind uses. */
const STABLE_SOCKET_NAME = "dictation.sock";

/** A command line is a few words; anything longer is not one. */
const MAX_COMMAND_BYTES = 256;
const CONNECTION_TIMEOUT_MS = 2_000;

/**
 * The socket path for this instance. The default packaged instance gets a stable name, so a
 * Hyprland bind can be written once. Any other instance (development, or one isolated through
 * `XDG_CONFIG_HOME`) gets a name from its userData directory: the single-instance lock lives
 * there, so two running instances never share a userData directory, and never a socket.
 */
export function resolveDictationSocketPath(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isDevelopment: boolean;
  readonly userDataPath: string;
  readonly uid: number;
  readonly tmpDir: string;
}): string {
  const runtimeDir = input.env.XDG_RUNTIME_DIR?.trim();
  const directory = runtimeDir
    ? NodePath.join(runtimeDir, "mesura-code")
    : NodePath.join(input.tmpDir, `mesura-code-${input.uid}`);
  const isolated = input.isDevelopment || Boolean(input.env.XDG_CONFIG_HOME?.trim());
  if (!isolated) return NodePath.join(directory, STABLE_SOCKET_NAME);
  const digest = NodeCrypto.createHash("sha256").update(input.userDataPath).digest("hex");
  return NodePath.join(directory, `dictation-${digest.slice(0, 12)}.sock`);
}

const SHELL_SAFE = /^[\w@%+=:,./-]+$/;

/** Hyprland runs `exec` through `sh -c`. */
export function shellQuote(argument: string): string {
  return SHELL_SAFE.test(argument) ? argument : `'${argument.replaceAll("'", `'\\''`)}'`;
}

/**
 * The shell command a Hyprland bind runs for `command`: the words to the socket, and the
 * second launch when that fails (no instance listening, or no `socat` installed).
 */
export function dictationSocketCommand(input: {
  readonly socketPath: string;
  readonly launcher: ReadonlyArray<string>;
  readonly command: DictationKeybindingCommand;
}): string {
  const commandLine = dictationCommandLineArguments(input.command);
  const words = commandLine.slice(1).join(" ");
  const fallback = [...input.launcher, ...commandLine].map(shellQuote).join(" ");
  return `printf '${words}\\n' | socat -u - ${shellQuote(`UNIX-CONNECT:${input.socketPath}`)} 2>/dev/null || ${fallback}`;
}

/** The command one connection sent, or null for anything that is not one. */
export function parseDictationSocketLine(line: string): DictationKeybindingCommand | null {
  const words = line.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return parseDictationCommandLine([DICTATION_FLAG, ...words]);
}

/**
 * Listens on `socketPath` and calls `onCommand` once per connection that sends a valid command
 * line. The directory is private to the user (0700) and the socket 0600. A leftover socket file
 * is replaced: the single-instance lock means no other instance owns this userData directory.
 */
export function listenForDictationCommands(input: {
  readonly socketPath: string;
  readonly onCommand: (command: DictationKeybindingCommand) => void;
  readonly onError: (cause: unknown) => void;
}): { readonly ready: Promise<void>; readonly close: () => void } {
  const server = NodeNet.createServer((connection) => {
    let received = "";
    let handled = false;
    const handle = () => {
      if (handled) return;
      handled = true;
      const command = parseDictationSocketLine(received.split("\n")[0] ?? "");
      if (command !== null) input.onCommand(command);
      connection.end();
    };
    connection.setEncoding("utf8");
    connection.setTimeout(CONNECTION_TIMEOUT_MS, () => connection.destroy());
    connection.on("data", (chunk: string) => {
      received += chunk;
      if (received.length > MAX_COMMAND_BYTES) {
        handled = true;
        connection.destroy();
      } else if (received.includes("\n")) {
        handle();
      }
    });
    connection.on("end", handle);
    connection.on("error", () => connection.destroy());
  });
  server.on("error", input.onError);

  const ready = new Promise<void>((resolve, reject) => {
    try {
      NodeFS.mkdirSync(NodePath.dirname(input.socketPath), { recursive: true, mode: 0o700 });
      NodeFS.rmSync(input.socketPath, { force: true });
    } catch (cause) {
      reject(cause);
      return;
    }
    server.once("error", reject);
    server.listen(input.socketPath, () => {
      server.off("error", reject);
      try {
        NodeFS.chmodSync(input.socketPath, 0o600);
        resolve();
      } catch (cause) {
        reject(cause);
      }
    });
  });
  ready.catch(input.onError);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    server.close();
    NodeFS.rmSync(input.socketPath, { force: true });
  };
  return { ready, close };
}

/** The defaults `resolveDictationSocketPath` reads from this process. */
export const processSocketDefaults = () => ({
  uid: process.getuid?.() ?? 0,
  tmpDir: NodeOS.tmpdir(),
});
