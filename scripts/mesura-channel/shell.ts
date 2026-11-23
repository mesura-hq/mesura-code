// @effect-diagnostics nodeBuiltinImport:off - Runs host and SSH commands for the channel scripts.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Pairing credentials travel inside URLs (`#token=`, or `%3D`-encoded inside a `t3code://` link). */
export function redactSecrets(text: string): string {
  return text.replace(/(token(?:=|%3D|%253D|":\s*"))[A-Za-z0-9._~+/-]+/giu, "$1<redacted>");
}

export function shellCommand(argv: ReadonlyArray<string>): string {
  return argv.map(shellQuote).join(" ");
}

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  /** Streams output to this file descriptor instead of capturing it. */
  readonly outputFd?: number;
}

/** Runs a command to completion and returns its stdout; a non-zero exit throws with stderr. */
export function run(
  command: string,
  args: ReadonlyArray<string>,
  options: RunOptions = {},
): string {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.input === undefined ? {} : { input: options.input }),
    stdio: [
      options.input === undefined ? "ignore" : "pipe",
      options.outputFd ?? "pipe",
      options.outputFd ?? "pipe",
    ],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim();
    throw new Error(
      redactSecrets(
        `${command} ${args.join(" ")} exited with ${result.status ?? result.signal}${detail ? `:\n${detail}` : ""}`,
      ),
    );
  }
  return result.stdout ?? "";
}

function sshArgs(target: string, connectTimeoutSeconds: number): Array<string> {
  return [
    ...[
      "BatchMode=yes",
      `ConnectTimeout=${connectTimeoutSeconds}`,
      "ServerAliveInterval=15",
    ].flatMap((option) => ["-o", option]),
    target,
  ];
}

/** Runs a POSIX sh script on the SSH target through stdin, so values need one quoting layer. */
export function runRemote(target: string, script: string, options: RunOptions = {}): string {
  return run("ssh", [...sshArgs(target, 10), "sh", "-s"], {
    ...options,
    input: `set -eu\n${script}\n`,
  });
}

/** Whether the SSH target answers within a short connect timeout, without a password prompt. */
export function isSshReachable(target: string): boolean {
  try {
    run("ssh", [...sshArgs(target, 8), "true"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Takes an exclusive `flock` on `path` without waiting, or returns undefined when another process
 * holds it. The lock belongs to the open file, so it lasts until the returned handle is disposed.
 */
export function tryHoldFileLock(path: string): Disposable | undefined {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  const fd = NodeFS.openSync(path, "a", 0o600);
  const busyExit = 75;
  const result = NodeChildProcess.spawnSync("flock", ["-n", "-E", String(busyExit), "3"], {
    stdio: ["ignore", "ignore", "pipe", fd],
    encoding: "utf8",
  });
  if (result.status === 0) return { [Symbol.dispose]: () => NodeFS.closeSync(fd) };
  NodeFS.closeSync(fd);
  if (result.status === busyExit) return undefined;
  throw result.error ?? new Error(`flock ${path} exited with ${result.status}: ${result.stderr}`);
}

/** Writes JSON under a temporary name and renames it, so a reader never sees a partial file. */
export function writeJsonAtomic(path: string, value: unknown): void {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  NodeFS.renameSync(`${path}.tmp`, path);
}

/**
 * Runs the packaged server CLI of an AppImage through its own Electron, the way the release swap
 * scripts do; the CLI lives inside the mounted `app.asar`, whose path only the AppImage knows.
 */
export function bundledCliScript(appImage: string, cliArgs: ReadonlyArray<string>): string {
  const trampoline = [
    'const path = require("node:path");',
    'const bin = path.join(process.env.APPDIR, "resources/app.asar/apps/server/dist/bin.mjs");',
    'const result = require("node:child_process").spawnSync(process.execPath, [bin, ...process.argv.slice(1)], { stdio: "inherit" });',
    "process.exit(result.status === null ? 1 : result.status);",
  ].join(" ");
  return `ELECTRON_RUN_AS_NODE=1 ${shellCommand([appImage, "-e", trampoline, ...cliArgs])}`;
}

/**
 * Starts a command on the machine's Hyprland desktop. The systemd user environment can carry a
 * stale instance signature, so this takes the newest live instance directory. Hyprland's IPC takes
 * Lua dispatchers since its Lua config.
 */
export function hyprlandExecScript(commandLine: string): string {
  if (/[^\x20-\x7e]/u.test(commandLine)) {
    throw new Error("A Hyprland command line must be printable ASCII.");
  }
  // JSON string escapes for printable ASCII (\" and \\) are valid Lua string escapes.
  const dispatch = `hl.dsp.exec_cmd(${JSON.stringify(commandLine)})`;
  return [
    `sig=$(find "/run/user/$(id -u)/hypr" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2)`,
    `[ -n "$sig" ] || { echo "no Hyprland session on this machine; start the app from its desktop" >&2; exit 1; }`,
    `HYPRLAND_INSTANCE_SIGNATURE=$sig hyprctl dispatch ${shellQuote(dispatch)} >/dev/null`,
  ].join("\n");
}

/** Waits until `url` answers 200, for at most `seconds` of wall time on the machine that runs it. */
export function readinessWaitScript(url: string, seconds: number): string {
  return [
    `deadline=$(($(date +%s) + ${Math.max(0, Math.floor(seconds))}))`,
    `until [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 ${shellQuote(url)})" = 200 ]; do`,
    `  [ "$(date +%s)" -lt "$deadline" ] || { echo ${shellQuote(`${url} did not answer in time`)} >&2; exit 1; }`,
    "  sleep 2",
    "done",
  ].join("\n");
}

export function sha256File(path: string): string {
  const hash = NodeCrypto.createHash("sha256");
  const fd = NodeFS.openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = NodeFS.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    NodeFS.closeSync(fd);
  }
  return hash.digest("hex");
}
