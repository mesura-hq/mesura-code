import { recordedDictationMs, type DictationRecordingSession } from "./dictationSessionStore";

/** A recording in this window is running or paused; the strip goes away once it stops. */
export type DictationRecordingPhase = "recording" | "paused";

export function dictationRecordingPhase(
  session: DictationRecordingSession,
): DictationRecordingPhase {
  return session.runningSince === null ? "paused" : "recording";
}

/** The time recorded up to the last microphone sample, as the strip shows it. */
export function dictationRecordedElapsedMs(session: DictationRecordingSession): number {
  return Math.floor(recordedDictationMs(session, session.sampledAt));
}

/** Recorded time as `mm:ss`. */
export function formatDictationElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  return `${Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0")}:${(totalSeconds % 60).toString().padStart(2, "0")}`;
}

export function dictationPhaseLabel(phase: DictationRecordingPhase): string {
  return phase === "recording" ? "Recording" : "Paused";
}

export function shouldAnimateDictationWaveform(input: {
  readonly active: boolean;
  readonly reducedMotion: boolean;
  readonly phase: DictationRecordingPhase;
}): boolean {
  return input.active && !input.reducedMotion && input.phase === "recording";
}
