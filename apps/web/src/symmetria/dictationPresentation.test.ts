import {
  SymmetriaDictationSessionId,
  type SymmetriaDictationSession,
} from "@symmetria/broker-contract";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "vite-plus/test";

import {
  claimDictationReservation,
  dictationMicrophonePresentation,
  dictationPhaseLabel,
  formatDictationTime,
  isActiveDictationSession,
  nextDictationMode,
  releaseDictationReservation,
  shouldAnimateDictationWaveform,
  shouldOwnDictationPresentation,
  shouldPresentDictationInMesura,
} from "./dictationPresentation";

const threadTarget = {
  kind: "thread" as const,
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-a"),
};

const session: SymmetriaDictationSession = {
  protocolVersion: { major: 1, minor: 4 },
  sessionId: SymmetriaDictationSessionId.make("session-a"),
  target: threadTarget,
  source: "shell",
  phase: "recording",
  mode: "submit",
  projectName: "Mesura Code",
  startedAt: "2026-08-29T12:00:00.000Z",
  elapsedMs: 65_000,
  audioLevel: 0.42,
  graceRemainingMs: null,
  presentation: { mesuraOwnsPresentation: false, leaseExpiresAt: null },
};

it("presents only the exact focused visible target", () => {
  assert.isTrue(
    shouldPresentDictationInMesura({
      session,
      displayedTarget: session.target,
      focused: true,
      visible: true,
    }),
  );
  assert.isFalse(
    shouldPresentDictationInMesura({
      session,
      displayedTarget: { ...threadTarget, threadId: ThreadId.make("thread-b") },
      focused: true,
      visible: true,
    }),
  );
  assert.isFalse(
    shouldPresentDictationInMesura({
      session,
      displayedTarget: session.target,
      focused: false,
      visible: true,
    }),
  );
  assert.isFalse(
    shouldPresentDictationInMesura({
      session: { ...session, phase: "cancelled" },
      displayedTarget: session.target,
      focused: true,
      visible: true,
    }),
  );
  assert.isTrue(
    shouldPresentDictationInMesura({
      session: { ...session, phase: "failed" },
      displayedTarget: session.target,
      focused: true,
      visible: true,
    }),
  );
});

it("keeps ownership independent of phase and releases it after dismissal", () => {
  assert.isTrue(
    shouldOwnDictationPresentation({
      shouldPresent: true,
      sessionId: "session-a",
      dismissedSessionId: null,
    }),
  );
  assert.isFalse(
    shouldOwnDictationPresentation({
      shouldPresent: true,
      sessionId: "session-a",
      dismissedSessionId: "session-a",
    }),
  );
});

it("cycles one delivery mode and formats elapsed or grace time", () => {
  assert.equal(nextDictationMode("clipboard"), "inject");
  assert.equal(nextDictationMode("inject"), "submit");
  assert.equal(nextDictationMode("submit"), "clipboard");
  assert.equal(formatDictationTime(session), "01:05");
  assert.equal(
    formatDictationTime({ ...session, phase: "grace", graceRemainingMs: 2_010 }),
    "0:03",
  );
});

it("keeps terminal sessions out of the active-session guard", () => {
  assert.isTrue(isActiveDictationSession(session));
  assert.isFalse(isActiveDictationSession({ ...session, phase: "completed" }));
  assert.isFalse(isActiveDictationSession(null));
});

it("explains whether the composer microphone can start the Shell engine", () => {
  assert.deepEqual(
    dictationMicrophonePresentation({
      bridgeAvailable: false,
      error: null,
      active: false,
      reservationPending: false,
    }),
    { disabled: true, explanation: "Symmetria Shell dictation is unavailable" },
  );
  assert.deepEqual(
    dictationMicrophonePresentation({
      bridgeAvailable: true,
      error: null,
      active: false,
      reservationPending: false,
    }),
    { disabled: false, explanation: "Start voice dictation" },
  );
  assert.deepEqual(
    dictationMicrophonePresentation({
      bridgeAvailable: true,
      error: null,
      active: false,
      reservationPending: true,
    }),
    { disabled: true, explanation: "Starting voice dictation" },
  );
});

it("admits only one reservation while a microphone start is pending", () => {
  const pending = { current: false };

  assert.isTrue(claimDictationReservation(pending));
  assert.isFalse(claimDictationReservation(pending));
  releaseDictationReservation(pending);
  assert.isTrue(claimDictationReservation(pending));
});

it("distinguishes the initial confirmation from its background-watcher state", () => {
  assert.equal(dictationPhaseLabel("delivering"), "Confirming");
  assert.equal(dictationPhaseLabel("confirming"), "Still confirming");
});

it("animates recording and processing only while visible and motion is allowed", () => {
  assert.isTrue(
    shouldAnimateDictationWaveform({ active: true, reducedMotion: false, phase: "recording" }),
  );
  assert.isTrue(
    shouldAnimateDictationWaveform({ active: true, reducedMotion: false, phase: "processing" }),
  );
  assert.isFalse(
    shouldAnimateDictationWaveform({ active: false, reducedMotion: false, phase: "processing" }),
  );
  assert.isFalse(
    shouldAnimateDictationWaveform({ active: true, reducedMotion: true, phase: "processing" }),
  );
  assert.isFalse(
    shouldAnimateDictationWaveform({ active: true, reducedMotion: false, phase: "completed" }),
  );
});
