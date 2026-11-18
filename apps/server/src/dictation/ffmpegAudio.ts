// @effect-diagnostics nodeBuiltinImport:off - ffmpeg streams through child-process pipes, outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import type * as NodeStream from "node:stream";

import { VAD_SAMPLE_RATE } from "./sileroVadWorker.ts";

/** Points dictation at another ffmpeg binary; there is no UI for it. */
const FFMPEG_ENV = "T3CODE_DICTATION_FFMPEG";
const ffmpegBinary = () => process.env[FFMPEG_ENV] || "ffmpeg";

/** A stretch of decoded 16 kHz samples, end exclusive. */
export interface SampleRange {
  readonly start: number;
  readonly end: number;
}

const PCM_FORMAT = ["-ac", "1", "-ar", String(VAD_SAMPLE_RATE), "-f", "f32le"] as const;

function spawnFfmpeg(args: ReadonlyArray<string>, signal: AbortSignal, stdin: "pipe" | "ignore") {
  const child = NodeChildProcess.spawn(
    ffmpegBinary(),
    [...(stdin === "ignore" ? ["-nostdin"] : []), "-hide_banner", "-loglevel", "error", ...args],
    { stdio: [stdin, "pipe", "pipe"], signal },
  );
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-2_000);
  });
  // Settles only once a started process has exited, so a cancelled cut leaves nothing running.
  const closed = new Promise<void>((resolve, reject) => {
    let failure: Error | undefined;
    child.once("error", (error) => {
      if (child.pid === undefined) reject(error);
      else failure ??= error;
    });
    child.once("close", (code) => {
      if (failure) reject(failure);
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited (${code}): ${stderr.trim()}`));
    });
  });
  return { child, closed };
}

/** Hands `stdout` over one chunk at a time; pausing the pipe bounds what waits in memory. */
function consume(
  child: NodeChildProcess.ChildProcess,
  closed: Promise<void>,
  onChunk: (chunk: Buffer) => void | Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let consumer = Promise.resolve();
    child.stdout!.on("data", (chunk: Buffer) => {
      child.stdout!.pause();
      consumer = consumer
        .then(() => onChunk(chunk))
        .then(
          () => {
            child.stdout!.resume();
          },
          (error: unknown) => {
            child.kill("SIGKILL");
            reject(error);
          },
        );
    });
    closed.then(() => consumer.then(resolve, reject), reject);
  });
}

/** Turns byte chunks into whole float samples, carrying a split sample into the next chunk. */
function pcmChunks(onPcm: (pcm: Float32Array) => void | Promise<void>) {
  let carry = Buffer.alloc(0);
  return async (chunk: Buffer) => {
    const bytes = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    const whole = bytes.length - (bytes.length % 4);
    carry = Buffer.from(bytes.subarray(whole));
    if (whole === 0) return;
    // A copy: the pipe's buffer may not be aligned for a Float32Array view.
    const pcm = new Float32Array(whole / 4);
    new Uint8Array(pcm.buffer).set(bytes.subarray(0, whole));
    await onPcm(pcm);
  };
}

/**
 * Decodes a recording to 16 kHz mono float PCM, in order, as it arrives. Silero and the cut both
 * count these samples, never container timestamps, which can jump inside a recording.
 */
export function decodeToPcm(
  path: string,
  signal: AbortSignal,
  onPcm: (pcm: Float32Array) => Promise<void>,
): Promise<void> {
  const { child, closed } = spawnFfmpeg(["-i", path, ...PCM_FORMAT, "pipe:1"], signal, "ignore");
  return consume(child, closed, pcmChunks(onPcm));
}

function write(stream: NodeStream.Writable, bytes: Uint8Array): Promise<void> {
  if (stream.write(bytes)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const settle = (error?: Error) => {
      stream.off("drain", settle);
      stream.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onClose = () => settle(new Error("The ffmpeg encoder closed its input."));
    stream.once("drain", settle);
    stream.once("close", onClose);
  });
}

/**
 * Decodes the recording again and streams only the samples inside `ranges`, which are sorted
 * and disjoint, into an Ogg Opus encoder. Returns the file and how many samples went into it.
 */
export async function encodeSampleRanges(
  path: string,
  ranges: ReadonlyArray<SampleRange>,
  signal: AbortSignal,
): Promise<{ readonly audio: Uint8Array; readonly samples: number }> {
  // Either process failing stops the other; both are awaited, so no rejection is left unobserved.
  const local = new AbortController();
  const stopBoth = () => local.abort(signal.reason);
  if (signal.aborted) stopBoth();
  else signal.addEventListener("abort", stopBoth, { once: true });
  const encoder = spawnFfmpeg(
    [
      "-f",
      "f32le",
      "-ar",
      String(VAD_SAMPLE_RATE),
      "-ac",
      "1",
      "-i",
      "pipe:0",
      "-c:a",
      "libopus",
      "-b:a",
      "32k",
      "-application",
      "voip",
      "-f",
      "ogg",
      "pipe:1",
    ],
    local.signal,
    "pipe",
  );
  const stdin = encoder.child.stdin!;
  stdin.on("error", () => undefined);
  const output: Buffer[] = [];
  const encoded = consume(encoder.child, encoder.closed, (chunk) => {
    output.push(chunk);
  });
  let offset = 0;
  let next = 0;
  let samples = 0;
  const decoded = decodeToPcm(path, local.signal, async (pcm) => {
    const blockEnd = offset + pcm.length;
    while (next < ranges.length && ranges[next]!.start < blockEnd) {
      const range = ranges[next]!;
      const from = Math.max(range.start, offset);
      const to = Math.min(range.end, blockEnd);
      if (to > from) {
        const slice = pcm.subarray(from - offset, to - offset);
        await write(stdin, new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength));
        samples += to - from;
      }
      if (range.end > blockEnd) break;
      next += 1;
    }
    offset = blockEnd;
  }).finally(() => stdin.end());
  const outcomes = await Promise.allSettled([
    decoded.catch((error: unknown) => {
      local.abort(error);
      throw error;
    }),
    encoded.catch((error: unknown) => {
      local.abort(error);
      throw error;
    }),
  ]);
  signal.removeEventListener("abort", stopBoth);
  const failure = signal.aborted
    ? { reason: signal.reason as unknown }
    : outcomes.find((outcome) => outcome.status === "rejected");
  if (failure) throw failure.reason;
  return { audio: new Uint8Array(Buffer.concat(output)), samples };
}

/** How many 16 kHz samples an encoded file decodes to; rejects when it does not decode. */
export async function decodedSampleCount(audio: Uint8Array, signal: AbortSignal): Promise<number> {
  const decoder = spawnFfmpeg(["-i", "pipe:0", ...PCM_FORMAT, "pipe:1"], signal, "pipe");
  let bytes = 0;
  const decoded = consume(decoder.child, decoder.closed, (chunk) => {
    bytes += chunk.length;
  });
  decoder.child.stdin!.on("error", () => undefined);
  decoder.child.stdin!.end(audio);
  await decoded;
  return Math.floor(bytes / 4);
}
