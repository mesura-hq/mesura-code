import { afterEach, describe, expect, it } from "vite-plus/test";

import { createFakeMedia } from "./dictationMedia.testFixtures";
import { openDictationRecording, setDictationMediaBackend } from "./recorder";

afterEach(() => setDictationMediaBackend(null));

describe("dictation recorder setup", () => {
  it("dictation phase 4 regression: a recorder that cannot be created releases the microphone", async () => {
    const media = createFakeMedia();
    setDictationMediaBackend(media.backend);
    media.failRecorder("create");
    await expect(openDictationRecording()).rejects.toThrow("recorder setup failed");
    expect(media.stoppedTracks).toEqual([1]);
  });

  it("dictation phase 4 regression: a recorder that cannot start releases the microphone and its meter", async () => {
    const media = createFakeMedia();
    setDictationMediaBackend(media.backend);
    media.failRecorder("start");
    await expect(openDictationRecording()).rejects.toThrow("recorder start failed");
    expect(media.stoppedTracks).toEqual([1]);
    expect(media.meterCloses).toEqual([1]);
  });
});
