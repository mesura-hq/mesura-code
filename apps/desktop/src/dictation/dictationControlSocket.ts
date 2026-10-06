// @effect-diagnostics nodeBuiltinImport:off -- a Unix socket is the native boundary a Hyprland bind reaches.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { DictationKeybindingCommand } from "@t3tools/contracts";

import {
  dictationCommandFromWords,
  dictationCommandLineArguments,
  dictationCommandWords,
} from "./dictationCommandLine.ts";

/**
 * The fast way into a running instance's dictation on Linux. A second launch of the app hands
 * `--dictation …` over through the single-instance lock, but it has to boot Electron (and,
 * packaged, mount the AppImage) first: 2 to 3.5 s per key press on the laptop. A bind that
 * writes the command words to this socket with `socat` lands in a few milliseconds. The second
 * launch stays as the bind's fallback, for when the socket is missing.
 *
 * The protocol is one line, the words after `--dictation` (`toggle`, `mode inject`).
 */

/** The socket of the default packaged instance: the path a hand-written Hyprland bind uses. */
const STABLE_SOCKET_NAME = "dictation.sock";

/** A command line is a few words; anything longer is not one. */
const MAX_COMMAND_LENGTH = 256;
const CONNECTION_TIMEOUT_MS = 2_000;
const PROBE_TIMEOUT_MS = 500;

/**
 * This user's Mesura runtime directory, shared with the server's runtime registry
 * (`apps/server/src/hostStats/serverRuntimeRegistry.ts`), which follows the same rule: a relative
 * `XDG_RUNTIME_DIR` is invalid by the XDG spec and ignored.
 */
function mesuraRuntimeDirectory(input: {
  readonly xdgRuntimeDir: string | undefined;
  readonly tmpDir: string;
  readonly uid: number;
}): string {
  const xdg = input.xdgRuntimeDir?.trim();
  return xdg && NodePath.isAbsolute(xdg)
    ? NodePath.join(xdg, "mesura-code")
    : NodePath.join(input.tmpDir, `mesura-code-${input.uid}`);
}

/**
 * The socket path for this instance. The default packaged instance gets a stable name, so a
 * Hyprland bind can be written once. Any other instance (development, or one isolated through an
 * `XDG_CONFIG_HOME` other than `~/.config`) gets a name from its userData directory: the
 * single-instance lock lives there, so two running instances never share a userData directory,
 * and never a socket. Session managers often export `XDG_CONFIG_HOME=~/.config`, which is the
 * default, not an isolation.
 */
export function resolveDictationSocketPath(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isDevelopment: boolean;
  readonly userDataPath: string;
  readonly homeDir: string;
  readonly uid: number;
  readonly tmpDir: string;
}): string {
  const directory = mesuraRuntimeDirectory({
    xdgRuntimeDir: input.env.XDG_RUNTIME_DIR,
    tmpDir: input.tmpDir,
    uid: input.uid,
  });
  const configHome = input.env.XDG_CONFIG_HOME?.trim();
  const isolatedConfig =
    Boolean(configHome) &&
    NodePath.resolve(configHome!) !== NodePath.join(input.homeDir, ".config");
  if (!input.isDevelopment && !isolatedConfig) return NodePath.join(directory, STABLE_SOCKET_NAME);
  const digest = NodeCrypto.createHash("sha256").update(input.userDataPath).digest("hex");
  return NodePath.join(directory, `dictation-${digest.slice(0, 12)}.sock`);
}

const SHELL_SAFE = /^[\w@%+=:,./-]+$/;

/** Hyprland runs `exec` through `sh -c`. */
export function shellQuote(argument: string): string {
  return SHELL_SAFE.test(argument) ? argument : `'${argument.replaceAll("'", `'\\''`)}'`;
}

/** The second launch that runs `command`: the slow way in, and the socket's fallback. */
export function dictationLaunchCommand(input: {
  readonly launcher: ReadonlyArray<string>;
  readonly command: DictationKeybindingCommand;
}): string {
  return [...input.launcher, ...dictationCommandLineArguments(input.command)]
    .map(shellQuote)
    .join(" ");
}

/** Characters `socat` reads as address syntax even inside a shell-quoted argument. */
const SOCAT_ADDRESS_SYNTAX = /[,:!\s'"\\]/;

/**
 * The shell command a Hyprland bind runs for `command`: the words to the socket, and the
 * second launch when that fails (no instance listening, or no `socat` installed). A socket path
 * `socat` cannot address gets the second launch alone.
 */
export function dictationSocketCommand(input: {
  readonly socketPath: string;
  readonly launcher: ReadonlyArray<string>;
  readonly command: DictationKeybindingCommand;
}): string {
  const fallback = dictationLaunchCommand(input);
  if (SOCAT_ADDRESS_SYNTAX.test(input.socketPath)) return fallback;
  const words = shellQuote(dictationCommandWords(input.command).join(" "));
  return `printf '%s\\n' ${words} | socat -u - ${shellQuote(`UNIX-CONNECT:${input.socketPath}`)} 2>/dev/null || ${fallback}`;
}

/** The command one connection sent, or null for anything that is not exactly one. */
export function parseDictationSocketLine(line: string): DictationKeybindingCommand | null {
  const words = line.trim().split(/\s+/).filter(Boolean);
  return words.length === 0 ? null : dictationCommandFromWords(words);
}

/**
 * Creates the socket directory and makes it private. Refuses a symlink or a directory another
 * user owns: in the tmpdir fallback either could be planted before this process runs.
 */
function preparePrivateDirectory(directory: string): void {
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = NodeFS.lstatSync(directory);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) {
    throw new Error(`${directory} is not a directory of this user; not listening there.`);
  }
  if ((stat.mode & 0o077) !== 0) NodeFS.chmodSync(directory, 0o700);
}

/** Whether a live process answers on `socketPath`. Anything else (no file, stale file) is not. */
function isServed(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = NodeNet.createConnection(socketPath);
    const settle = (served: boolean) => {
      probe.destroy();
      resolve(served);
    };
    probe.once("connect", () => settle(true));
    probe.once("error", () => settle(false));
    // A path that neither accepts nor refuses is someone's; leave it alone.
    probe.setTimeout(PROBE_TIMEOUT_MS, () => settle(true));
  });
}

/**
 * Listens on `socketPath` and calls `onCommand` once per connection that sends a valid command
 * line. The directory is private to the user (0700) and the socket 0600.
 *
 * `ready` resolves to `"served-elsewhere"`, without listening and without touching the file,
 * when a live process already answers there. A second instance builds this before it learns it
 * is the second one and quits, and replacing the first instance's socket would cut every bind
 * over to the slow path. A file nothing answers on is a crashed instance's, and is replaced.
 * `ready` resolves to `"closed"` when `close` came first. `close` removes the file only when this
 * listener bound it.
 */
export function listenForDictationCommands(input: {
  readonly socketPath: string;
  readonly onCommand: (command: DictationKeybindingCommand) => void;
  readonly onError: (cause: unknown) => void;
}): {
  readonly ready: Promise<"listening" | "served-elsewhere" | "closed">;
  readonly close: () => void;
} {
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
      if (received.length > MAX_COMMAND_LENGTH) {
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

  let bound = false;
  let closed = false;
  const ready = (async () => {
    preparePrivateDirectory(NodePath.dirname(input.socketPath));
    if (await isServed(input.socketPath)) return "served-elsewhere" as const;
    if (closed) return "closed" as const;
    NodeFS.rmSync(input.socketPath, { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(input.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    bound = true;
    if (closed) {
      // close() ran while listen was in flight; it could not remove what was not bound yet.
      server.close();
      NodeFS.rmSync(input.socketPath, { force: true });
      return "closed" as const;
    }
    NodeFS.chmodSync(input.socketPath, 0o600);
    return "listening" as const;
  })();
  ready.catch(input.onError);

  const close = () => {
    if (closed) return;
    closed = true;
    if (!bound) return;
    server.close();
    NodeFS.rmSync(input.socketPath, { force: true });
  };
  return { ready, close };
}

/** The defaults `resolveDictationSocketPath` reads from this process. */
export const processSocketDefaults = () => ({
  uid: process.getuid?.() ?? 0,
  tmpDir: NodeOS.tmpdir(),
  homeDir: NodeOS.homedir(),
});
