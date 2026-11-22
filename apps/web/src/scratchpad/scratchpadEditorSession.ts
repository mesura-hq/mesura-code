import { ThreadId } from "@t3tools/contracts";

const STORAGE_KEY = "mesura-scratchpad-editor-session";

function newSessionKey(): string {
  // Not `crypto.randomUUID`: a phone reaching the host over plain HTTP lacks it.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sessionKeyForThisTab(): string {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored !== null) return stored;
    const created = newSessionKey();
    sessionStorage.setItem(STORAGE_KEY, created);
    return created;
  } catch {
    return newSessionKey();
  }
}

/**
 * The thread id the scratchpad's Neovim session is keyed by: one per browser tab, kept across
 * reloads. Neovim input names only the session, so two clients sharing one would type into
 * whichever buffer the other opened last. Separate from every real thread, so the file panel's
 * session is never replaced.
 */
export const SCRATCHPAD_EDITOR_THREAD_ID = ThreadId.make(
  `mesura-scratchpad-${sessionKeyForThisTab()}`,
);
