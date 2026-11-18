import { decodeToPcm, encodeRanges } from "./ffmpegAudio.ts";
import { openSileroVad, VAD_FRAME_SAMPLES, VAD_SAMPLE_RATE } from "./sileroVadWorker.ts";
import { boundRanges, speechRanges, speechSeconds } from "./speechRanges.ts";

export type SpeechOnlyAudio =
  | {
      readonly kind: "filtered";
      readonly audio: Uint8Array;
      readonly speechMs: number;
      readonly recordingMs: number;
    }
  /** Almost all of it is speech: the original is sent as it is, not re-encoded. */
  | { readonly kind: "unchanged"; readonly recordingMs: number }
  | { readonly kind: "no-speech"; readonly recordingMs: number };

/** About ten seconds per IPC round trip to Silero. */
const FEED_SAMPLES = 10 * VAD_SAMPLE_RATE;
const MIN_SPEECH_SECONDS = 0.25;
const UNCHANGED_SPEECH_SHARE = 0.95;
/** Each range is about 35 characters of ffmpeg filter; 1500 stay far below one argument's limit. */
const MAX_RANGES = 1_500;

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

  const recordingSeconds = samples / VAD_SAMPLE_RATE;
  const recordingMs = Math.round(recordingSeconds * 1000);
  const ranges = boundRanges(speechRanges(probs), MAX_RANGES);
  const speech = speechSeconds(ranges);
  if (speech < MIN_SPEECH_SECONDS) return { kind: "no-speech", recordingMs };
  if (speech >= recordingSeconds * UNCHANGED_SPEECH_SHARE)
    return { kind: "unchanged", recordingMs };
  const audio = await encodeRanges(audioPath, ranges, signal);
  return { kind: "filtered", audio, speechMs: Math.round(speech * 1000), recordingMs };
}
