import { isElectron } from "~/env";

/**
 * Mesura: Android gives a hidden page's microphone silence about a minute after the screen locks,
 * while the track still reads live (https://issues.chromium.org/issues/40660229). Only a native
 * foreground service keeps it, so a phone recording holds the screen on and warns after a long hide.
 */
export interface RecordingScreenEnvironment {
  /** False where a hidden page keeps its microphone (desktop), which turns the guard off. */
  readonly hiddenPageLosesMicrophone: boolean;
  readonly document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  readonly wakeLock: Pick<WakeLock, "request"> | undefined;
  readonly now: () => number;
}

export interface RecordingScreenHandlers {
  /** Read when the page hides: a paused recording loses nothing while hidden. */
  readonly isCapturing: () => boolean;
  /** The page came back after a hide long enough for Android to have cut the microphone. */
  readonly onMicrophoneMayHaveStopped: (hiddenMs: number) => void;
}

export interface RecordingScreenGuard {
  readonly release: () => void;
}

/** Chrome on Android cuts the microphone about 60 s after the page hides; warn a little before. */
export const HIDDEN_MICROPHONE_CUTOFF_MS = 50_000;

const NO_GUARD: RecordingScreenGuard = { release: () => undefined };

function browserRecordingScreenEnvironment(): RecordingScreenEnvironment | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  return {
    hiddenPageLosesMicrophone:
      !isElectron && window.matchMedia?.("(pointer: coarse)").matches === true,
    document,
    wakeLock: navigator.wakeLock,
    now: () => Date.now(),
  };
}

let environmentOverride: RecordingScreenEnvironment | null = null;

/** Replaces the browser's page and wake lock APIs; `null` restores them. */
export function setRecordingScreenEnvironment(environment: RecordingScreenEnvironment | null) {
  environmentOverride = environment;
}

/** Holds the screen on for one recording and reports a hide the microphone may not have survived. */
export function guardRecordingScreen(handlers: RecordingScreenHandlers): RecordingScreenGuard {
  const environment = environmentOverride ?? browserRecordingScreenEnvironment();
  if (!environment?.hiddenPageLosesMicrophone) return NO_GUARD;
  const { document: page, wakeLock, now } = environment;

  let released = false;
  let lock: WakeLockSentinel | null = null;
  let requesting = false;
  // A return to the page while a request was pending; a refusal of that request owes it one retry.
  let requestedAgainWhilePending = false;
  let capturingHiddenSince: number | null = null;

  const holdScreen = () => {
    if (!wakeLock || (lock && !lock.released)) return;
    if (requesting) {
      requestedAgainWhilePending = true;
      return;
    }
    requesting = true;
    wakeLock.request("screen").then(
      (sentinel) => {
        requesting = false;
        requestedAgainWhilePending = false;
        if (released) {
          void sentinel.release().catch(() => undefined);
          return;
        }
        lock = sentinel;
        // The browser drops the lock whenever the page hides; a hide that ended first missed it.
        if (page.visibilityState === "visible" && sentinel.released) holdScreen();
      },
      // Refused (battery saver, a hidden page): the recording goes on without it.
      () => {
        requesting = false;
        const retry = requestedAgainWhilePending;
        requestedAgainWhilePending = false;
        if (retry && !released && page.visibilityState === "visible") holdScreen();
      },
    );
  };

  const onVisibilityChange = () => {
    if (page.visibilityState === "hidden") {
      capturingHiddenSince = handlers.isCapturing() ? now() : null;
      return;
    }
    const hiddenSince = capturingHiddenSince;
    capturingHiddenSince = null;
    holdScreen();
    if (hiddenSince === null) return;
    const hiddenMs = now() - hiddenSince;
    if (hiddenMs >= HIDDEN_MICROPHONE_CUTOFF_MS) handlers.onMicrophoneMayHaveStopped(hiddenMs);
  };

  page.addEventListener("visibilitychange", onVisibilityChange);
  if (page.visibilityState === "visible") holdScreen();
  else if (handlers.isCapturing()) capturingHiddenSince = now();

  return {
    release: () => {
      if (released) return;
      released = true;
      page.removeEventListener("visibilitychange", onVisibilityChange);
      void lock?.release().catch(() => undefined);
      lock = null;
    },
  };
}

/** "45 s" under a minute and a half, whole minutes above. */
export function formatHiddenDuration(hiddenMs: number): string {
  const seconds = Math.round(hiddenMs / 1000);
  if (seconds < 90) return `${seconds} s`;
  return `${Math.round(seconds / 60)} min`;
}
