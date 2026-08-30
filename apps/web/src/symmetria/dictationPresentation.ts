import type {
  SymmetriaDictationMode,
  SymmetriaDictationPhase,
  SymmetriaDictationSession,
  SymmetriaDictationTarget,
} from "@symmetria/broker-contract";

import { dictationTargetsEqual } from "./dictationTarget";

export const ACTIVE_DICTATION_PHASES: ReadonlySet<SymmetriaDictationPhase> = new Set([
  "recording",
  "paused",
  "processing",
  "grace",
  "delivering",
  "confirming",
]);

export function isActiveDictationSession(session: SymmetriaDictationSession | null): boolean {
  return session !== null && ACTIVE_DICTATION_PHASES.has(session.phase);
}

export function dictationMicrophonePresentation(input: {
  readonly bridgeAvailable: boolean;
  readonly error: string | null;
  readonly active: boolean;
  readonly reservationPending: boolean;
}): { readonly disabled: boolean; readonly explanation: string } {
  if (!input.bridgeAvailable) {
    return { disabled: true, explanation: "Symmetria Shell dictation is unavailable" };
  }
  if (input.reservationPending) {
    return { disabled: true, explanation: "Starting voice dictation" };
  }
  if (input.error) return { disabled: input.active, explanation: input.error };
  if (input.active) {
    return { disabled: true, explanation: "A dictation session is already active" };
  }
  return { disabled: false, explanation: "Start voice dictation" };
}

export function claimDictationReservation(pending: { current: boolean }): boolean {
  if (pending.current) return false;
  pending.current = true;
  return true;
}

export function releaseDictationReservation(pending: { current: boolean }): void {
  pending.current = false;
}

export function shouldPresentDictationInMesura(input: {
  readonly session: SymmetriaDictationSession | null;
  readonly displayedTarget: SymmetriaDictationTarget;
  readonly focused: boolean;
  readonly visible: boolean;
}): boolean {
  return Boolean(
    input.session &&
    input.session.phase !== "cancelled" &&
    input.focused &&
    input.visible &&
    dictationTargetsEqual(input.session.target, input.displayedTarget),
  );
}

export function shouldOwnDictationPresentation(input: {
  readonly shouldPresent: boolean;
  readonly sessionId: string | null;
  readonly dismissedSessionId: string | null;
}): boolean {
  return input.shouldPresent && input.sessionId !== input.dismissedSessionId;
}

export function nextDictationMode(mode: SymmetriaDictationMode): SymmetriaDictationMode {
  if (mode === "clipboard") return "inject";
  if (mode === "inject") return "submit";
  return "clipboard";
}

export function formatDictationTime(session: SymmetriaDictationSession): string {
  if (session.phase === "grace" && session.graceRemainingMs !== null) {
    return `0:${Math.ceil(session.graceRemainingMs / 1000)
      .toString()
      .padStart(2, "0")}`;
  }
  const totalSeconds = Math.floor(session.elapsedMs / 1000);
  return `${Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0")}:${(totalSeconds % 60).toString().padStart(2, "0")}`;
}

export function dictationPhaseLabel(phase: SymmetriaDictationPhase): string {
  switch (phase) {
    case "recording":
      return "Recording";
    case "paused":
      return "Paused";
    case "processing":
      return "Processing";
    case "grace":
      return "Ready to send";
    case "delivering":
      return "Confirming";
    case "confirming":
      return "Still confirming";
    case "completed":
      return "Delivered";
    case "failed":
      return "Delivery failed";
    case "cancelled":
      return "Cancelled";
  }
}

export function shouldAnimateDictationWaveform(input: {
  readonly active: boolean;
  readonly reducedMotion: boolean;
  readonly phase: SymmetriaDictationPhase;
}): boolean {
  return (
    input.active &&
    !input.reducedMotion &&
    (input.phase === "recording" || input.phase === "processing" || input.phase === "grace")
  );
}
