import { assert, it } from "vite-plus/test";

import {
  dictationPhaseLabel,
  dictationRecordedElapsedMs,
  dictationRecordingPhase,
  formatDictationElapsed,
  shouldAnimateDictationWaveform,
} from "./dictationPresentation";
import type { DictationRecordingSession } from "./dictationSessionStore";

const session: DictationRecordingSession = {
  sessionId: "recording-a",
  mode: "submit",
  startedAt: 1_000,
  bankedMs: 60_000,
  runningSince: 10_000,
  level: 0.4,
  sampledAt: 15_400,
};

it("reads a running recording as recording and a paused one as paused", () => {
  assert.equal(dictationRecordingPhase(session), "recording");
  assert.equal(dictationRecordingPhase({ ...session, runningSince: null }), "paused");
  assert.equal(dictationPhaseLabel("recording"), "Recording");
  assert.equal(dictationPhaseLabel("paused"), "Paused");
});

it("shows the time banked across pauses plus the running stretch up to the last sample", () => {
  assert.equal(dictationRecordedElapsedMs(session), 65_400);
  assert.equal(dictationRecordedElapsedMs({ ...session, runningSince: null }), 60_000);
  assert.equal(formatDictationElapsed(65_400), "01:05");
  assert.equal(formatDictationElapsed(0), "00:00");
});

it("animates the waveform only while recording, visible, and motion is allowed", () => {
  assert.isTrue(
    shouldAnimateDictationWaveform({ active: true, reducedMotion: false, phase: "recording" }),
  );
  assert.isFalse(
    shouldAnimateDictationWaveform({ active: true, reducedMotion: false, phase: "paused" }),
  );
  assert.isFalse(
    shouldAnimateDictationWaveform({ active: false, reducedMotion: false, phase: "recording" }),
  );
  assert.isFalse(
    shouldAnimateDictationWaveform({ active: true, reducedMotion: true, phase: "recording" }),
  );
});
