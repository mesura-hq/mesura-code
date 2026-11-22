import type { SampleRange } from "./ffmpegAudio.ts";
import { VAD_FRAME_SAMPLES, VAD_SAMPLE_RATE } from "./sileroVadWorker.ts";

const framesFor = (ms: number) => Math.ceil((ms * VAD_SAMPLE_RATE) / 1000 / VAD_FRAME_SAMPLES);

// The thresholds of upstream's capture filter in `speech/audio.ts` (`createSpeechAudio.score`),
// which cannot be reused here: it is stringified into the speech worker and holds the whole
// recording's PCM, 173 MB for a 45-minute dictation. Keep the two in step.
const VOICED_PROBABILITY = 0.3;
const ONSET_FRAMES = framesFor(60);
const PREFILL_FRAMES = framesFor(450);
const TAIL_FRAMES = framesFor(450);

/**
 * The decoded samples of a recording to keep, from Silero's per-frame speech probabilities: speech
 * confirmed after 60 ms, with 450 ms kept before it and after it. A syllable cut off before its
 * onset confirmed is kept too.
 */
export function speechRanges(probs: ReadonlyArray<number>): ReadonlyArray<SampleRange> {
  const keep = new Array<boolean>(probs.length).fill(false);
  let inSpeech = false;
  let onsetCount = 0;
  let hangover = 0;
  for (let index = 0; index < probs.length; index += 1) {
    const voiced = probs[index]! > VOICED_PROBABILITY;
    if (!inSpeech && voiced) {
      onsetCount += 1;
      if (onsetCount >= ONSET_FRAMES) {
        inSpeech = true;
        hangover = TAIL_FRAMES;
        onsetCount = 0;
        for (let back = Math.max(0, index - PREFILL_FRAMES); back <= index; back += 1) {
          keep[back] = true;
        }
      }
    } else if (inSpeech && voiced) {
      hangover = TAIL_FRAMES;
      keep[index] = true;
    } else if (inSpeech && hangover > 0) {
      hangover -= 1;
      keep[index] = true;
    } else {
      inSpeech = false;
      onsetCount = 0;
    }
  }
  if (onsetCount > 0) {
    for (
      let back = Math.max(0, probs.length - 1 - PREFILL_FRAMES);
      back < probs.length;
      back += 1
    ) {
      keep[back] = true;
    }
  }

  const ranges: SampleRange[] = [];
  let start: number | null = null;
  for (let index = 0; index <= keep.length; index += 1) {
    if (index < keep.length && keep[index]) {
      start ??= index;
    } else if (start !== null) {
      ranges.push({ start: start * VAD_FRAME_SAMPLES, end: index * VAD_FRAME_SAMPLES });
      start = null;
    }
  }
  return ranges;
}
