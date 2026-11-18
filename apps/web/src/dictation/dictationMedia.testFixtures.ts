import type { DictationMediaBackend } from "./recorder";

/** A `MediaRecorder` that records calls and yields one small WebM chunk when stopped. */
export class FakeMediaRecorder extends EventTarget {
  state: RecordingState = "inactive";
  readonly mimeType: string;
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  readonly calls: string[] = [];

  constructor(
    readonly options: MediaRecorderOptions,
    private readonly failOnStart = false,
  ) {
    super();
    this.mimeType = options.mimeType ?? "";
  }

  start() {
    this.calls.push("start");
    if (this.failOnStart) throw new Error("recorder start failed");
    this.state = "recording";
  }

  pause() {
    this.calls.push("pause");
    this.state = "paused";
  }

  resume() {
    this.calls.push("resume");
    this.state = "recording";
  }

  stop() {
    this.calls.push("stop");
    if (this.state === "inactive") return;
    this.state = "inactive";
    const data = Object.assign(new Event("dataavailable"), {
      data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3])], {
        type: this.mimeType,
      }),
    }) as BlobEvent;
    this.ondataavailable?.(data);
    this.dispatchEvent(data);
    const stopped = new Event("stop");
    this.onstop?.(stopped);
    this.dispatchEvent(stopped);
  }
}

/**
 * The fake microphone for `setDictationMediaBackend`. Open n (from 1) records its device id;
 * `stoppedTracks` lists streams whose track stopped. `preferMicrophone` sets the chosen id,
 * `holdMicrophone` parks the next open until `releaseMicrophone`, `failRecorder` breaks one.
 */
export function createFakeMedia() {
  const recorders: FakeMediaRecorder[] = [];
  const openedMicrophones: string[] = [];
  let preferredMicrophoneId = "";
  const stoppedTracks: number[] = [];
  const meterCloses: number[] = [];
  let held: (() => void) | null = null;
  let holdNext = false;
  let failNext: "create" | "start" | null = null;
  const backend: DictationMediaBackend = {
    // The hold sits on the first step of opening, so a release right after a start reaches it.
    chooseMicrophones: async () => {
      if (holdNext) {
        holdNext = false;
        await new Promise<void>((resolve) => {
          held = resolve;
        });
      }
      return {
        candidates: preferredMicrophoneId ? [preferredMicrophoneId, ""] : [""],
        idsHidden: false,
      };
    },
    openMicrophone: async (microphoneId) => {
      openedMicrophones.push(microphoneId);
      const index = openedMicrophones.length;
      return {
        getTracks: () => [{ stop: () => stoppedTracks.push(index) }],
        getAudioTracks: () => [{ stop: () => stoppedTracks.push(index) }],
      } as unknown as MediaStream;
    },
    isTypeSupported: (mimeType) => mimeType.startsWith("audio/webm"),
    createMediaRecorder: (_stream, options) => {
      const failure = failNext;
      failNext = null;
      if (failure === "create") throw new Error("recorder setup failed");
      const recorder = new FakeMediaRecorder(options, failure === "start");
      recorders.push(recorder);
      return recorder as unknown as MediaRecorder;
    },
    createLevelMeter: () => ({
      read: () => 0.4,
      close: () => meterCloses.push(openedMicrophones.length),
    }),
  };
  return {
    backend,
    recorders,
    openedMicrophones,
    stoppedTracks,
    meterCloses,
    preferMicrophone: (microphoneId: string) => {
      preferredMicrophoneId = microphoneId;
    },
    holdMicrophone: () => {
      holdNext = true;
    },
    releaseMicrophone: () => {
      held?.();
      held = null;
    },
    failRecorder: (stage: "create" | "start") => {
      failNext = stage;
    },
  };
}
