import { useSyncExternalStore } from "react";

import { isActiveDictationSession } from "../symmetria/dictationPresentation";
import { useDictationSessionStore } from "../symmetria/dictationSessionStore";

/**
 * One microphone admission rule for the composer's two capture starts. A voice call claims the
 * microphone synchronously when the phone is pressed, before its asynchronous history and
 * permission checks, and releases it only after its capture has closed. Dictation claims it while
 * the Symmetria Shell reserves the microphone; a recording shell session also blocks a call even
 * when the shell started it on its own.
 */
export type MicrophoneUser = "call" | "dictation";

const CALL_BLOCKS_DICTATION = "Dictation is unavailable during a voice call";
const DICTATION_BLOCKS_CALL = "Voice call is unavailable while dictation is active";

let holder: { readonly user: MicrophoneUser; readonly token: symbol } | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

/** Why `user` cannot start now, or null when the microphone is free for it. */
export function microphoneBlocker(user: MicrophoneUser): string | null {
  if (user === "dictation") return holder?.user === "call" ? CALL_BLOCKS_DICTATION : null;
  if (holder?.user === "dictation") return DICTATION_BLOCKS_CALL;
  if (holder?.user === "call") return null;
  return isActiveDictationSession(useDictationSessionStore.getState().session)
    ? DICTATION_BLOCKS_CALL
    : null;
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
