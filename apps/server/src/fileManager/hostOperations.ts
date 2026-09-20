// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - the file manager's operations are a promise surface its registry calls directly, so the bounded wait is a plain timer
import * as NodeChildProcess from "node:child_process";
import type * as NodeStream from "node:stream";

import { createEntry, renameEntry, transfer } from "@symmetria/fm-main/ops/mutate";
import type { Operations } from "@symmetria/fm-main/ops/operations";

/**
 * The file manager's write operations, on this server's host.
 *
 * The shape is `Operations` from the vendored `fm-main`, which its registry
 * calls as promises. Copy, move, create and rename are the file manager's own
 * implementation (`ops/mutate.ts`, plain `node:fs`). The two that reach the
 * desktop are this host's: the standalone uses Electron's `shell.trashItem`
 * and `shell.openPath`, which do not exist here.
 *
 * **Trash is `gio trash`, deliberately.** It implements the freedesktop trash
 * specification (the `.trashinfo` record that makes a restore possible, the
 * per-mount fallback), which the file manager's own note refuses to
 * reimplement; a "trash" that cannot be restored from is a delete with a
 * friendlier name. A long selection is trashed in batches, so the argument
 * list stays under the kernel's limit.
 *
 * **Open is `xdg-open`**, detached and unreferenced: the program it starts may
 * run for hours and must not hold the server. Success means the opener
 * STARTED. A detached opener cannot report its exit, so a file type nothing
 * handles (`xdg-open` exits 3) answers success and nothing appears; the
 * standalone, which waits on Electron's `shell.openPath`, reports that case.
 * Waiting on `xdg-open` here would hold the RPC for the life of the program
 * it opens, which is the worse trade.
 *
 * Either binary missing is reported as a failure line in the file manager's
 * status bar, never as a crash; a host command that never finishes is killed
 * after a bounded wait and reported the same way.
 */

/** What this module needs of a spawned process; `node:child_process` satisfies it. */
export interface SpawnedHostProcess {
  readonly stderr: NodeStream.Readable | null;
  /** `close`, not `exit`: only `close` follows the stdio streams' flush. */
  once(event: "close", listener: (code: number | null, signal: string | null) => void): this;
  once(event: "spawn", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
  unref(): void;
}

/** Only stderr is read; stdout is discarded so a chatty command cannot block on a full pipe. */
export type HostStdio = "ignore" | readonly ["ignore", "ignore", "pipe"];

export type SpawnHostProcess = (
  command: string,
  args: readonly string[],
  options: { readonly detached?: boolean; readonly stdio: HostStdio },
) => SpawnedHostProcess;

const nodeSpawn: SpawnHostProcess = (command, args, options) =>
  NodeChildProcess.spawn(command, [...args], {
    ...options,
    stdio: options.stdio === "ignore" ? "ignore" : [...options.stdio],
  });

/** How long a host command may take before it is killed and reported. */
export const HOST_COMMAND_TIMEOUT_MS = 30_000;

/** How many paths one `gio trash` invocation carries. */
export const TRASH_BATCH_SIZE = 256;

function isMissingBinary(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function notInstalled(command: string): Error {
  return new Error(`${command} is not installed on the host`);
}

/**
 * Run a host command to completion; reject with its stderr when it fails, and
 * kill it when it outlives the bounded wait.
 */
function runToClose(
  spawn: SpawnHostProcess,
  command: string,
  args: readonly string[],
  timeoutMs: number,
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} did not finish within ${String(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(isMissingBinary(error) ? notInstalled(command) : error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited with code ${String(code)}`));
    });
  });
}

/** Start a desktop program and let go of it; resolve once it has spawned. */
function startDetached(spawn: SpawnHostProcess, command: string, args: readonly string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    const onError = (error: Error) => {
      reject(isMissingBinary(error) ? notInstalled(command) : error);
    };
    child.once("error", onError);
    child.once("spawn", () => {
      // Started. The program's exit is not waited for, and an error after
      // this point belongs to the program, not to the RPC.
      child.removeListener("error", onError);
      resolve();
    });
    child.unref();
  });
}

function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    out.push(items.slice(offset, offset + size));
  }
  return out;
}

export interface HostOperationsOptions {
  readonly spawn?: SpawnHostProcess;
  readonly commandTimeoutMs?: number;
}

export function createHostOperations(options: HostOperationsOptions = {}): Operations {
  const spawn = options.spawn ?? nodeSpawn;
  const timeoutMs = options.commandTimeoutMs ?? HOST_COMMAND_TIMEOUT_MS;
  /** Transfers that can still be cancelled, by the id the caller gave. */
  const running = new Map<string, AbortController>();

  return {
    async transfer(args, onProgress) {
      // One controller per id: the NEWEST transfer under an id owns the cancel
      // handle, and a finished transfer removes only its own controller, so
      // an overlapping reuse of the id stays cancellable.
      const controller = new AbortController();
      running.set(args.transferId, controller);
      try {
        return await transfer({
          sources: args.sources,
          destination: args.destination,
          mode: args.mode,
          overwrite: args.overwrite,
          signal: controller.signal,
          onProgress,
        });
      } finally {
        if (running.get(args.transferId) === controller) running.delete(args.transferId);
      }
    },
    cancelTransfer(transferId) {
      running.get(transferId)?.abort();
    },
    create: createEntry,
    rename: renameEntry,
    async trash(paths) {
      for (const batch of batches(paths, TRASH_BATCH_SIZE)) {
        await runToClose(spawn, "gio", ["trash", ...batch], timeoutMs);
      }
      return paths.length;
    },
    async open(path) {
      await startDetached(spawn, "xdg-open", [path]);
      return "desktop";
    },
  };
}
