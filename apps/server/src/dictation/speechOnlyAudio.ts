import { decodedSampleCount, decodeToPcm, encodeSampleRanges } from "./ffmpegAudio.ts";
import { openSileroVad, VAD_FRAME_SAMPLES, VAD_SAMPLE_RATE } from "./sileroVadWorker.ts";
import { speechRanges } from "./speechRanges.ts";

export type SpeechOnlyAudio =
  | {
      readonly kind: "filtered";
      readonly audio: Uint8Array;
      readonly speechMs: number;
      readonly recordingMs: number;
    }
  /** Almost all of it is speech: the original is sent as it is, not re-encoded. */
  | { readonly kind: "unchanged"; readonly recordingMs: number }
  | { readonly kind: "no-speech"; readonly recordingMs: number }
  /** The cut did not come out as the speech it should hold; the original is sent instead. */
  | { readonly kind: "invalid-cut"; readonly recordingMs: number; readonly reason: string };

/** About ten seconds per IPC round trip to Silero. */
const FEED_SAMPLES = 10 * VAD_SAMPLE_RATE;
const MIN_SPEECH_SECONDS = 0.25;
const UNCHANGED_SPEECH_SHARE = 0.95;
/** Opus pre-skip and padding move a decoded length by milliseconds, never by this much. */
const CUT_TOLERANCE_SECONDS = 0.25;

/** Silero's verdict on a recording, then the speech alone, cut by ffmpeg into Ogg Opus. */
export async function speechOnlyAudio(
  audioPath: string,
  vadPath: string,
  signal: AbortSignal,
): Promise<SpeechOnlyAudio> {
  const vad = await openSileroVad(vadPath, signal);
  const probs: number[] = [];
  const score = (frames: { firstFrame: number; probs: ReadonlyArray<number> }) => {
    if (frames.firstFrame !== probs.length) throw new Error("Silero skipped frames.");
    for (const probability of frames.probs) {
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
        throw new Error("Silero returned an invalid probability.");
      }
      probs.push(probability);
    }
  };
  let samples = 0;
  try {
    let pending: Float32Array[] = [];
    let pendingSamples = 0;
    const feedPending = async () => {
      if (pendingSamples === 0) return;
      const block = new Float32Array(pendingSamples);
      let offset = 0;
      for (const pcm of pending) {
        block.set(pcm, offset);
        offset += pcm.length;
      }
      pending = [];
      pendingSamples = 0;
      score(await vad.feed(block));
    };
    await decodeToPcm(audioPath, signal, async (pcm) => {
      samples += pcm.length;
      pending.push(pcm);
      pendingSamples += pcm.length;
      if (pendingSamples >= FEED_SAMPLES) await feedPending();
    });
    await feedPending();
    score(await vad.flush());
  } finally {
    vad.kill();
  }
  if (probs.length !== Math.ceil(samples / VAD_FRAME_SAMPLES)) {
    throw new Error("Silero scored an incomplete recording.");
  }

  const recordingMs = Math.round((samples / VAD_SAMPLE_RATE) * 1000);
  const ranges = speechRanges(probs).map((range) => ({
    start: Math.min(range.start, samples),
    end: Math.min(range.end, samples),
  }));
  const speechSamples = ranges.reduce((total, range) => total + range.end - range.start, 0);
  if (speechSamples < MIN_SPEECH_SECONDS * VAD_SAMPLE_RATE) {
    return { kind: "no-speech", recordingMs };
  }
  if (speechSamples >= samples * UNCHANGED_SPEECH_SHARE) return { kind: "unchanged", recordingMs };
  const cut = await encodeSampleRanges(audioPath, ranges, signal);
  const reason = await checkCut(cut, speechSamples, signal);
  if (reason !== null) return { kind: "invalid-cut", recordingMs, reason };
  return {
    kind: "filtered",
    audio: cut.audio,
    speechMs: Math.round((cut.samples / VAD_SAMPLE_RATE) * 1000),
    recordingMs,
  };
}

/** Why the cut cannot stand in for the recording, or null when it holds the kept speech. */
export async function checkCut(
  cut: { readonly audio: Uint8Array; readonly samples: number },
  expectedSamples: number,
  signal: AbortSignal,
): Promise<string | null> {
  const tolerance = CUT_TOLERANCE_SECONDS * VAD_SAMPLE_RATE;
  if (Math.abs(cut.samples - expectedSamples) > tolerance) {
    return `the cut took ${cut.samples} of ${expectedSamples} speech samples`;
  }
  if (cut.audio.length === 0) return "the cut is empty";
  const decoded = await decodedSampleCount(cut.audio, signal).catch(() => 0);
  if (Math.abs(decoded - cut.samples) > tolerance) {
    return `the cut decodes to ${decoded} of ${cut.samples} samples`;
  }
  return null;
}
