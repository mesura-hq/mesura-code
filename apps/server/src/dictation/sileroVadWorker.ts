// @effect-diagnostics nodeBuiltinImport:off - native inference runs in a killable child process, outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeSea from "node:sea";

import { loaderEntry } from "../speech/native.ts";

/** Silero scores 512-sample frames of 16 kHz mono audio. */
export const VAD_SAMPLE_RATE = 16_000;
export const VAD_FRAME_SAMPLES = 512;

// The same isolated-process rule as the speech worker: native inference can crash, and
// disposing it mid-call segfaults, so the parent only ever kills the child.
const workerEntry = `
const describe = (error) => (error instanceof Error ? error.message : String(error));
const start = async () => {
  const speech = await loadSpeechModule(moduleUrl);
  const model = await speech.TranscribeModel.load(vadPath, { backend: "cpu" });
  if (model.vadInfo.sampleRate !== 16000 || model.vadInfo.frameSamples !== 512)
    throw new Error("Unsupported Silero model frames.");
  const vad = model.createVadSession({ nThreads: 1 });
  await vad.streamReset();
  process.on("message", async (message) => {
    try {
      const result = message.kind === "flush" ? await vad.streamFlush() : await vad.streamFeed(message.pcm);
      process.send({ ok: true, firstFrame: result.firstFrame, probs: Array.from(result.probs) });
    } catch (error) {
      process.send({ ok: false, error: describe(error) });
    }
  });
  process.on("disconnect", () => process.kill(process.pid, "SIGKILL"));
  process.send({ ok: true, ready: true });
};
await start().catch((error) =>
  process.send({ ok: false, error: "Silero could not load: " + describe(error) }, () => process.exit(1)),
);
`;

/** The CLI fast path a standalone executable re-runs itself with, since it cannot evaluate code. */
export const SILERO_VAD_WORKER_COMMAND = "__dictation-vad-worker";

/** How a host starts the worker: the CLI fast path in a standalone executable, else `-e`. */
export function sileroVadWorkerArgs(vadPath: string, standalone = NodeSea.isSea()): string[] {
  if (standalone) return [SILERO_VAD_WORKER_COMMAND, vadPath];
  const loader = `const baseUrl = ${JSON.stringify(import.meta.url)};
    const moduleUrl = undefined; const vadPath = process.argv[1];${loaderEntry}`;
  return ["--input-type=module", "-e", loader + workerEntry, vadPath];
}

/** The worker body, run by the CLI fast path. */
export async function runSileroVadWorker(vadPath: string): Promise<void> {
  if (!process.send) throw new Error("The Silero worker requires an IPC channel.");
  const run = new Function(
    "baseUrl",
    "moduleUrl",
    "vadPath",
    `return (async () => {${loaderEntry}${workerEntry}})();`,
  ) as (baseUrl: string, moduleUrl: undefined, vadPath: string) => Promise<void>;
  await run(import.meta.url, undefined, vadPath);
}

type Reply = {
  readonly ok: boolean;
  readonly ready?: boolean;
  readonly firstFrame?: number;
  readonly probs?: ReadonlyArray<number>;
  readonly error?: string;
};

export interface SileroFrames {
  readonly firstFrame: number;
  readonly probs: ReadonlyArray<number>;
}

export interface SileroVadSession {
  /** Scores the next PCM block: the probabilities of the frames it completed. */
  readonly feed: (pcm: Float32Array) => Promise<SileroFrames>;
  /** Scores the zero-padded partial frame at the end. */
  readonly flush: () => Promise<SileroFrames>;
  readonly kill: () => void;
}

/** Starts Silero in its own process; rejects when the native package or model cannot load. */
export async function openSileroVad(
  vadPath: string,
  signal: AbortSignal,
): Promise<SileroVadSession> {
  signal.throwIfAborted();
  const child = NodeChildProcess.spawn(process.execPath, sileroVadWorkerArgs(vadPath), {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    serialization: "advanced",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", TRANSCRIBE_BACKENDS: "cpu" },
  });
  let pending: ReturnType<typeof Promise.withResolvers<Reply>> | undefined;
  let stopped: Error | undefined;
  const fail = (error: Error) => {
    stopped ??= error;
    pending?.reject(error);
    pending = undefined;
  };
  const kill = () => {
    fail(new Error("Silero stopped."));
    child.kill("SIGKILL");
  };
  signal.addEventListener("abort", kill, { once: true });
  child.on("error", fail);
  child.on("exit", (code, exitSignal) => {
    signal.removeEventListener("abort", kill);
    fail(new Error(`Silero exited (${exitSignal ?? code}).`));
  });
  child.on("message", (message: Reply) => {
    const request = pending;
    pending = undefined;
    if (message.ok) request?.resolve(message);
    else request?.reject(new Error(message.error ?? "Silero failed."));
  });
  const next = () => {
    if (stopped) return Promise.reject(stopped);
    pending = Promise.withResolvers<Reply>();
    return pending.promise;
  };
  const send = async (message: object): Promise<SileroFrames> => {
    const reply = next();
    // A worker that died between requests fails the reply, never throws past it unobserved.
    if (!stopped) {
      child.send(message, (error) => {
        if (error) fail(error);
      });
    }
    const { firstFrame, probs } = await reply;
    if (typeof firstFrame !== "number" || !Array.isArray(probs)) {
      throw new Error("Invalid Silero reply.");
    }
    return { firstFrame, probs };
  };
  try {
    await next();
  } catch (error) {
    kill();
    throw error;
  }
  return {
    feed: (pcm) => send({ kind: "feed", pcm }),
    flush: () => send({ kind: "flush" }),
    kill,
  };
}
