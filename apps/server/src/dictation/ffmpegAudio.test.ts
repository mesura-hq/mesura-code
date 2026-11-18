// @effect-diagnostics nodeBuiltinImport:off - fixtures are made by the ffmpeg binary under test.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { decodedSampleCount, decodeToPcm, encodeSampleRanges } from "./ffmpegAudio.ts";
import { checkCut } from "./speechOnlyAudio.ts";

const RATE = 16_000;
const hasFfmpeg = NodeChildProcess.spawnSync("ffmpeg", ["-version"]).status === 0;

/** Four seconds of tone whose timestamps jump four seconds forward after second two. */
function gappedFixture(directory: string, container: "webm" | "mp4") {
  const path = NodePath.join(directory, `gap.${container}`);
  const codec = container === "webm" ? ["-c:a", "libopus"] : ["-c:a", "aac"];
  const result = NodeChildProcess.spawnSync("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=4",
    "-af",
    "aresample=48000,asetpts='if(gte(T,2),PTS+4/TB,PTS)'",
    ...codec,
    path,
  ]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return path;
}

function toneFixture(directory: string, seconds: number) {
  const path = NodePath.join(directory, "tone.webm");
  const result = NodeChildProcess.spawnSync("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=330:duration=${seconds}`,
    "-c:a",
    "libopus",
    path,
  ]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return path;
}

async function decodedSamples(path: string) {
  let samples = 0;
  await decodeToPcm(path, new AbortController().signal, async (pcm) => {
    samples += pcm.length;
  });
  return samples;
}

describe.runIf(hasFfmpeg)("ffmpeg sample cuts", () => {
  it.each(["webm", "mp4"] as const)(
    "cuts by decoded sample, across a timestamp gap in %s",
    async (container) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dictation-cut-"));
      try {
        const path = gappedFixture(directory, container);
        const total = await decodedSamples(path);
        expect(total / RATE).toBeGreaterThan(3.9);
        const range = { start: Math.round(2.2 * RATE), end: Math.round(3.9 * RATE) };
        const cut = await encodeSampleRanges(path, [range], new AbortController().signal);
        expect(cut.samples).toBe(range.end - range.start);
        const decoded = await decodedSampleCount(cut.audio, new AbortController().signal);
        expect(Math.abs(decoded - cut.samples) / RATE).toBeLessThan(0.1);
      } finally {
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("cuts 1,600 ranges in one pass", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dictation-cut-"));
    try {
      const path = toneFixture(directory, 70);
      // 20 ms kept out of every 40 ms.
      const ranges = Array.from({ length: 1_600 }, (_, index) => ({
        start: index * 640,
        end: index * 640 + 320,
      }));
      const cut = await encodeSampleRanges(path, ranges, new AbortController().signal);
      expect(cut.samples).toBe(1_600 * 320);
      const decoded = await decodedSampleCount(cut.audio, new AbortController().signal);
      expect(Math.abs(decoded - cut.samples) / RATE).toBeLessThan(0.1);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe.runIf(hasFfmpeg)("checkCut", () => {
  it("rejects a cut that does not decode, is empty, or lost speech, and accepts a real one", async () => {
    const signal = new AbortController().signal;
    const broken = { audio: new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3]), samples: 16_000 };
    expect(await checkCut(broken, 16_000, signal)).toMatch(/does not decode/);
    expect(await checkCut({ audio: new Uint8Array(), samples: 16_000 }, 16_000, signal)).toBe(
      "the cut is empty",
    );
    expect(await checkCut(broken, 64_000, signal)).toMatch(/took 16000 of 64000/);
    // The minimum speech is 4,000 samples, as large as the decode tolerance.
    const brokenAtMinimum = { audio: broken.audio, samples: 4_000 };
    expect(await checkCut(brokenAtMinimum, 4_000, signal)).toMatch(/does not decode/);
    expect(await checkCut({ audio: broken.audio, samples: 3_999 }, 4_000, signal)).toMatch(
      /took 3999 of 4000/,
    );

    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dictation-cut-"));
    try {
      const cut = await encodeSampleRanges(
        toneFixture(directory, 3),
        [{ start: 0, end: 32_000 }],
        signal,
      );
      expect(await checkCut(cut, 32_000, signal)).toBeNull();
      const shortest = await encodeSampleRanges(
        toneFixture(directory, 3),
        [{ start: 0, end: 4_000 }],
        signal,
      );
      expect(await checkCut(shortest, 4_000, signal)).toBeNull();
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

/** Runs ffmpeg through a wrapper that records each process id, for the life of `run`. */
async function withRecordedFfmpegProcesses<T>(
  directory: string,
  run: (processIds: () => number[]) => Promise<T>,
): Promise<T> {
  const pidFile = NodePath.join(directory, "pids");
  const wrapper = NodePath.join(directory, "ffmpeg-wrapper.sh");
  NodeFS.writeFileSync(wrapper, `#!/bin/sh\necho $$ >> '${pidFile}'\nexec ffmpeg "$@"\n`, {
    mode: 0o755,
  });
  const previous = process.env.T3CODE_DICTATION_FFMPEG;
  process.env.T3CODE_DICTATION_FFMPEG = wrapper;
  try {
    return await run(() =>
      NodeFS.existsSync(pidFile)
        ? NodeFS.readFileSync(pidFile, "utf8").trim().split("\n").map(Number)
        : [],
    );
  } finally {
    if (previous === undefined) delete process.env.T3CODE_DICTATION_FFMPEG;
    else process.env.T3CODE_DICTATION_FFMPEG = previous;
  }
}

const isRunning = (processId: number) => {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
};

describe.runIf(hasFfmpeg)("cancelling a cut", () => {
  it("rejects once, after both ffmpeg processes are gone", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dictation-cut-"));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const path = toneFixture(directory, 60);
      await withRecordedFfmpegProcesses(directory, async (processIds) => {
        const controller = new AbortController();
        const cut = encodeSampleRanges(path, [{ start: 0, end: 60 * RATE }], controller.signal);
        setImmediate(() => controller.abort());
        await expect(cut).rejects.toMatchObject({ name: "AbortError" });
        // A process killed before its wrapper ran records no id.
        expect(processIds().length).toBeGreaterThan(0);
        expect(processIds().filter(isRunning)).toEqual([]);
      });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
