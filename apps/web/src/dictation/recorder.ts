/**
 * Records dictation audio from the window's microphone: one `MediaRecorder` per recording,
 * opus in WebM where the browser has it (MP4 otherwise), at 32 kbps so 45 minutes stay far
 * under OpenAI's 25 MB limit. An `AnalyserNode` reports the input level for the waveform.
 *
 * The browser surface sits behind `DictationMediaBackend`: happy-dom has none of it, so tests
 * install a fake through `setDictationMediaBackend`.
 */
export interface DictationLevelMeter {
  /** The current input level, 0-1. */
  readonly read: () => number;
  readonly close: () => void;
}

export interface DictationMediaBackend {
  readonly getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  readonly isTypeSupported: (mimeType: string) => boolean;
  readonly createMediaRecorder: (
    stream: MediaStream,
    options: MediaRecorderOptions,
  ) => MediaRecorder;
  readonly createLevelMeter: (stream: MediaStream) => DictationLevelMeter;
}

export interface DictationAudio {
  readonly blob: Blob;
  readonly mimeType: string;
}

export interface DictationRecording {
  readonly pause: () => void;
  readonly resume: () => void;
  /** Stops the microphone and resolves the whole recording as one file. */
  readonly stop: () => Promise<DictationAudio>;
  /** Stops the microphone and drops what was recorded. */
  readonly discard: () => void;
  readonly readLevel: () => number;
}

const PREFERRED_MIME_TYPES = ["audio/webm;codecs=opus", "audio/mp4"] as const;
const AUDIO_BITS_PER_SECOND = 32_000;
const CHUNK_INTERVAL_MS = 1_000;

/** Recordings stop by themselves here; at 32 kbps that is about 11 MB. */
export const DICTATION_MAX_RECORDING_MS = 45 * 60 * 1000;

function createBrowserLevelMeter(stream: MediaStream): DictationLevelMeter {
  const AudioContextClass = globalThis.AudioContext;
  if (!AudioContextClass) return { read: () => 0, close: () => undefined };
  const context = new AudioContextClass();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  return {
    read: () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      // Speech RMS sits around 0.05-0.2; scale it into the waveform's 0-1 range.
      return Math.min(1, Math.sqrt(sum / samples.length) * 4);
    },
    close: () => {
      void context.close().catch(() => undefined);
    },
  };
}

const browserBackend: DictationMediaBackend = {
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  isTypeSupported: (mimeType) =>
    typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mimeType),
  createMediaRecorder: (stream, options) => new MediaRecorder(stream, options),
  createLevelMeter: createBrowserLevelMeter,
};

let backendOverride: DictationMediaBackend | null = null;

/** Replaces the browser media APIs; `null` restores them. */
export function setDictationMediaBackend(backend: DictationMediaBackend | null): void {
  backendOverride = backend;
}

export async function openDictationRecording(): Promise<DictationRecording> {
  const backend = backendOverride ?? browserBackend;
  const stream = await backend.getUserMedia({ audio: true });
  const mimeType =
    PREFERRED_MIME_TYPES.find((candidate) => backend.isTypeSupported(candidate)) ?? "";
  const chunks: Blob[] = [];
  let recorder: MediaRecorder;
  let meter: DictationLevelMeter | null = null;
  try {
    recorder = backend.createMediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    });
    meter = backend.createLevelMeter(stream);
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.start(CHUNK_INTERVAL_MS);
  } catch (cause) {
    // No handle reaches the caller, so nothing else would ever release the microphone.
    meter?.close();
    for (const track of stream.getTracks()) track.stop();
    throw cause;
  }
  const levelMeter = meter;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    levelMeter.close();
    for (const track of stream.getTracks()) track.stop();
  };

  return {
    pause: () => {
      if (recorder.state === "recording") recorder.pause();
    },
    resume: () => {
      if (recorder.state === "paused") recorder.resume();
    },
    stop: () =>
      new Promise<DictationAudio>((resolve) => {
        const finish = () => {
          release();
          const type = recorder.mimeType || mimeType || "audio/webm";
          resolve({ blob: new Blob(chunks, { type }), mimeType: type });
        };
        if (recorder.state === "inactive") {
          finish();
          return;
        }
        recorder.addEventListener("stop", finish, { once: true });
        recorder.stop();
      }),
    discard: () => {
      chunks.length = 0;
      if (recorder.state !== "inactive") recorder.stop();
      release();
    },
    readLevel: () => (released ? 0 : levelMeter.read()),
  };
}
