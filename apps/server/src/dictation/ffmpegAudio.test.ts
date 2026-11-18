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
    expect(await checkCut(broken, 16_000, signal)).toMatch(/decodes to 0/);
    expect(await checkCut({ audio: new Uint8Array(), samples: 16_000 }, 16_000, signal)).toBe(
      "the cut is empty",
    );
    expect(await checkCut(broken, 64_000, signal)).toMatch(/took 16000 of 64000/);

    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dictation-cut-"));
    try {
      const cut = await encodeSampleRanges(
        toneFixture(directory, 3),
        [{ start: 0, end: 32_000 }],
        signal,
      );
      expect(await checkCut(cut, 32_000, signal)).toBeNull();
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
