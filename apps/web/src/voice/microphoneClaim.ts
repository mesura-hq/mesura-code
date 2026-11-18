import { useSyncExternalStore } from "react";

import { useDictationSessionStore } from "../dictation/dictationSessionStore";

/**
 * One microphone rule for calls and dictation. A call claims it synchronously on the phone press,
 * before any async check, and releases it after capture closes. Dictation claims it while opening
 * the microphone; from then on its recording session, paused or not, blocks a call. A comment
 * editor's dictation (`field`) holds the claim for its whole recording.
 */
export type MicrophoneUser = "call" | "dictation" | "field";

const CALL_BLOCKS_DICTATION = "Dictation is unavailable during a voice call";
const DICTATION_BLOCKS_CALL = "Voice call is unavailable while dictation is active";
const FIELD_BLOCKS_DICTATION = "Dictation is unavailable while a comment is being dictated";
const SESSION_BLOCKS_FIELD = "A dictation session is already active";

let holder: { readonly user: MicrophoneUser; readonly token: symbol } | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

/** Why `user` cannot start now, or null when the microphone is free for it. */
export function microphoneBlocker(user: MicrophoneUser): string | null {
  if (holder?.user === "field") {
    return user === "call" ? DICTATION_BLOCKS_CALL : FIELD_BLOCKS_DICTATION;
  }
  if (user !== "call" && holder?.user === "call") return CALL_BLOCKS_DICTATION;
  if (user === "dictation") return null;
  if (user === "field") {
    return useDictationSessionStore.getState().session !== null ? SESSION_BLOCKS_FIELD : null;
  }
  if (holder?.user === "dictation") return DICTATION_BLOCKS_CALL;
  if (holder?.user === "call") return null;
  return useDictationSessionStore.getState().session !== null ? DICTATION_BLOCKS_CALL : null;
}

/** Claims the microphone, or returns null when another user holds it. Release is idempotent. */
export function claimMicrophone(user: MicrophoneUser): (() => void) | null {
  if (microphoneBlocker(user) !== null || holder !== null) return null;
  const token = Symbol(user);
  holder = { user, token };
  notify();
  return () => {
    if (holder?.token !== token) return;
    holder = null;
    notify();
  };
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const unsubscribeDictation = useDictationSessionStore.subscribe(listener);
  return () => {
    listeners.delete(listener);
    unsubscribeDictation();
  };
};

/** Re-renders when the answer of `microphoneBlocker(user)` can change. */
export function useMicrophoneBlocker(user: MicrophoneUser): string | null {
  return useSyncExternalStore(
    subscribe,
    () => microphoneBlocker(user),
    () => null,
  );
}

export function resetMicrophoneClaimForTest(): void {
  holder = null;
  notify();
}
