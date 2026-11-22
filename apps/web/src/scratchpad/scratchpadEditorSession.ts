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

/**
 * Holds the key's lock for the page's life: "held", "taken" when another tab holds it, or
 * "unavailable" when the browser refuses lock requests altogether.
 */
function holdForPageLife(
  locks: LockManager,
  key: string,
): Promise<"held" | "taken" | "unavailable"> {
  return new Promise((resolve) => {
    locks
      .request(`mesura-scratchpad-editor-${key}`, { ifAvailable: true }, (lock) => {
        resolve(lock === null ? "taken" : "held");
        // Never settles, so the lock is released only when the page goes away.
        return lock === null ? undefined : new Promise<never>(() => {});
      })
      .catch(() => resolve("unavailable"));
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
  if (stored !== null) {
    const outcome = await holdForPageLife(locks, stored);
    if (outcome === "held") return stored;
    if (outcome === "unavailable") return newSessionKey();
  }
  const created = newSessionKey();
  // A fresh key is locked by nobody else; if the browser refuses the lock, it stays page-only.
  if ((await holdForPageLife(locks, created)) === "held") remember(created);
  return created;
}

let claimed: Promise<ThreadId> | null = null;
/** The key this page claimed, so retiring it can also stop a reload from claiming it again. */
let claimedKey: string | null = null;
/** Set when a close gave up on keys still queued for this session; see `retireScratchpadSession`. */
let retired = false;

/**
 * The thread id the scratchpad's Neovim session is keyed by: one per browser tab, held for the
 * tab's life. Neovim input names only the session, so two tabs sharing one would type into
 * whichever buffer the other opened last. Separate from every real thread, so the file panel's
 * session is never replaced. The overlay mounts its editor only once this resolves.
 */
export function scratchpadEditorThreadId(): Promise<ThreadId> {
  if (retired) {
    retired = false;
    claimed = Promise.resolve(ThreadId.make(`mesura-scratchpad-${newSessionKey()}`));
  }
  claimed ??= claimSessionKey().then((key) => {
    claimedKey = key;
    return ThreadId.make(`mesura-scratchpad-${key}`);
  });
  return claimed;
}

/**
 * The next open uses a new session: a close that hit its backstop may leave keys queued for the
 * old one, and a reopen there could receive them in a different note.
 */
export function retireScratchpadSession(): void {
  retired = true;
  // The lock stays held until the page goes, so no duplicate claims the key meanwhile; a reload
  // must not take it back either.
  try {
    if (claimedKey !== null && sessionStorage.getItem(STORAGE_KEY) === claimedKey) {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Without storage there is nothing a reload could reclaim.
  }
}
