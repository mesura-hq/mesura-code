// @effect-diagnostics nodeBuiltinImport:off - ffmpeg streams through child-process pipes, outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";

import type { SpeechRange } from "./speechRanges.ts";
import { VAD_SAMPLE_RATE } from "./sileroVadWorker.ts";

/** Points dictation at another ffmpeg binary; there is no UI for it. */
const FFMPEG_ENV = "T3CODE_DICTATION_FFMPEG";
const ffmpegBinary = () => process.env[FFMPEG_ENV] || "ffmpeg";

// Timestamps restart at zero and the audio is resampled first in both passes, so a range's
// seconds mean the same samples in the decoded PCM and in the cut.
const NORMALIZE = `asetpts=PTS-STARTPTS,aresample=${VAD_SAMPLE_RATE}`;

function run(
  args: ReadonlyArray<string>,
  signal: AbortSignal,
  onStdout: (chunk: Buffer) => void | Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      ffmpegBinary(),
      ["-nostdin", "-hide_banner", "-loglevel", "error", ...args],
      { stdio: ["ignore", "pipe", "pipe"], signal },
    );
    let stderr = "";
    let consumer = Promise.resolve();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2_000);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      // One chunk at a time: pausing ffmpeg's pipe bounds what waits in memory.
      child.stdout.pause();
      consumer = consumer
        .then(() => onStdout(chunk))
        .then(
          () => {
            child.stdout.resume();
          },
          (error: unknown) => {
            child.kill("SIGKILL");
            reject(error);
          },
        );
    });
    child.once("error", reject);
    child.once("close", (code) => {
      void consumer.then(() =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg exited (${code}): ${stderr.trim()}`)),
      );
    });
  });
}

/** Decodes a recording to 16 kHz mono float PCM, handed over in whole samples as it arrives. */
export function decodeToPcm(
  path: string,
  signal: AbortSignal,
  onPcm: (pcm: Float32Array) => Promise<void>,
): Promise<void> {
  let carry = Buffer.alloc(0);
  return run(
    ["-i", path, "-af", NORMALIZE, "-ac", "1", "-f", "f32le", "pipe:1"],
    signal,
    async (chunk) => {
      const bytes = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
      const whole = bytes.length - (bytes.length % 4);
      carry = Buffer.from(bytes.subarray(whole));
      if (whole === 0) return;
      // A copy: the pipe's buffer may not be aligned for a Float32Array view.
      const pcm = new Float32Array(whole / 4);
      new Uint8Array(pcm.buffer).set(bytes.subarray(0, whole));
      await onPcm(pcm);
    },
  );
}

/** Cuts `ranges` out of a recording and joins them into one Ogg Opus file. */
export async function encodeRanges(
  path: string,
  ranges: ReadonlyArray<SpeechRange>,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const select = ranges
    .map((range) => `between(t,${range.startSeconds.toFixed(3)},${range.endSeconds.toFixed(3)})`)
    .join("+");
  const chunks: Buffer[] = [];
  await run(
    [
      "-i",
      path,
      "-af",
      `${NORMALIZE},aselect='${select}',asetpts=N/SR/TB`,
      "-ac",
      "1",
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
    signal,
    (chunk) => {
      chunks.push(chunk);
    },
  );
  return new Uint8Array(Buffer.concat(chunks));
}
