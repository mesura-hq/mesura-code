/**
 * The recording strip is the real `DictationStripBanner`, fed a fake session,
 * so the prototype keeps the shipped look: round controls, cancel, stop, and
 * the one mode button with its Material icons.
 */
import {
  SymmetriaDictationSessionId,
  type SymmetriaDictationSession,
} from "@symmetria/broker-contract";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { DictationStripBanner } from "~/symmetria/DictationStrip";
import {
  cancelRecording,
  cycleDeliveryMode,
  finishRecording,
  recordedMsAt,
  restartRecording,
  togglePause,
  usePrototypeStore,
  type RecordingState,
} from "./prototypeStore";

export function formatClock(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  return `${Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0")}:${(totalSeconds % 60).toString().padStart(2, "0")}`;
}

/** The banner reads a Shell session; the prototype has no target until stop. */
function bannerSession(recording: RecordingState, now: number): SymmetriaDictationSession {
  return {
    protocolVersion: { major: 1, minor: 5 },
    sessionId: SymmetriaDictationSessionId.make(recording.sessionId),
    target: {
      kind: "thread",
      environmentId: EnvironmentId.make("prototype"),
      threadId: ThreadId.make("prototype"),
    },
    source: "mesura",
    phase: recording.runningSince === null ? "paused" : "recording",
    mode: recording.mode,
    projectName: null,
    startedAt: recording.startedAt,
    elapsedMs: Math.floor(recordedMsAt(recording, now)),
    audioLevel: recording.level,
    graceRemainingMs: null,
    presentation: { mesuraOwnsPresentation: true, leaseExpiresAt: null },
  };
}

const CONTROL_HANDLERS: Partial<Record<string, () => void>> = {
  pause: togglePause,
  resume: togglePause,
  restart: restartRecording,
  cancel: cancelRecording,
  stop: finishRecording,
};

/** The recording is global, so the strip shows on whichever thread is on screen. */
export function RecordingStrip() {
  const recording = usePrototypeStore((state) => state.recording);
  if (!recording) return null;
  return (
    <DictationStripBanner
      session={bannerSession(recording, Date.now())}
      reducedMotion={false}
      onControl={(action) => CONTROL_HANDLERS[action]?.()}
      onChangeMode={cycleDeliveryMode}
      onDismiss={() => undefined}
    />
  );
}
