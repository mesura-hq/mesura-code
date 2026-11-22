import { ThreadId } from "@t3tools/contracts";

const STORAGE_KEY = "mesura-scratchpad-editor-session";

function newSessionKey(): string {
  // Not `crypto.randomUUID`: a phone reaching the host over plain HTTP lacks it.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function storedSessionKey(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function remember(key: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, key);
  } catch {
    // Without storage the key lasts for this page only.
  }
}

/** Holds the key's lock for the page's life; false when another tab already holds it. */
function holdForPageLife(locks: LockManager, key: string): Promise<boolean> {
  return new Promise((resolve) => {
    void locks.request(`mesura-scratchpad-editor-${key}`, { ifAvailable: true }, (lock) => {
      resolve(lock !== null);
      // Never settles, so the lock is released only when the page goes away.
      return lock === null ? undefined : new Promise<never>(() => {});
    });
  });
}

/**
 * One key per tab, owned through a Web Lock: a reload takes the same key back (its Neovim is
 * reused), a duplicated tab finds the inherited key locked and makes a new one. Without Web Locks
 * (plain HTTP is no secure context) every page takes a new key, never shared.
 */
async function claimSessionKey(): Promise<string> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (locks === undefined) return newSessionKey();
  const stored = storedSessionKey();
  if (stored !== null && (await holdForPageLife(locks, stored))) return stored;
  for (;;) {
    const created = newSessionKey();
    if (await holdForPageLife(locks, created)) {
      remember(created);
      return created;
    }
  }
}

let claimed: Promise<ThreadId> | null = null;

/**
 * The thread id the scratchpad's Neovim session is keyed by: one per browser tab, held for the
 * tab's life. Neovim input names only the session, so two tabs sharing one would type into
 * whichever buffer the other opened last. Separate from every real thread, so the file panel's
 * session is never replaced. The overlay mounts its editor only once this resolves.
 */
export function scratchpadEditorThreadId(): Promise<ThreadId> {
  claimed ??= claimSessionKey().then((key) => ThreadId.make(`mesura-scratchpad-${key}`));
  return claimed;
}
