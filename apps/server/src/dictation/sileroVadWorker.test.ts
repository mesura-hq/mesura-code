// @effect-diagnostics nodeBuiltinImport:off - drives the CLI entry point as a child process.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { SILERO_VAD_WORKER_COMMAND, sileroVadWorkerArgs } from "./sileroVadWorker.ts";

const CLI_ENTRY = NodePath.join(import.meta.dirname, "..", "bin.ts");

/** The first IPC message a child sends, or its exit when it sends none. */
function firstMessage(args: ReadonlyArray<string>) {
  return new Promise<unknown>((resolve) => {
    const child = NodeChildProcess.spawn(process.execPath, args, {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    child.once("message", (message) => {
      resolve(message);
      child.kill("SIGKILL");
    });
    child.once("exit", (code) => resolve({ exited: code }));
  });
}

describe("Silero worker launch", () => {
  it("re-runs a standalone executable through the CLI fast path, not Node flags", () => {
    expect(sileroVadWorkerArgs("/models/silero.gguf", true)).toEqual([
      SILERO_VAD_WORKER_COMMAND,
      "/models/silero.gguf",
    ]);
    expect(sileroVadWorkerArgs("/models/silero.gguf", false)[0]).toBe("--input-type=module");
  });

  it("reaches the worker through the CLI entry point and reports a model that cannot load", async () => {
    // The CLI entry point with the arguments a standalone executable receives.
    const message = await firstMessage([
      CLI_ENTRY,
      ...sileroVadWorkerArgs("/nonexistent/silero.gguf", true),
    ]);
    expect(message).toMatchObject({
      ok: false,
      error: expect.stringContaining("Silero could not load"),
    });
  });
});
