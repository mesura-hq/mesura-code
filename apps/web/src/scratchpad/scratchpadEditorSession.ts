import { ThreadId } from "@t3tools/contracts";

const STORAGE_KEY = "mesura-scratchpad-editor-session";
const CHANNEL_NAME = "mesura-scratchpad-editor-session";

function newSessionKey(): string {
  // Not `crypto.randomUUID`: a phone reaching the host over plain HTTP lacks it.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function remember(key: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, key);
  } catch {
    // Without storage the key lasts for this page only.
  }
}

function storedSessionKey(): string {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored !== null) return stored;
  } catch {
    // Fall through to a new key.
  }
  const created = newSessionKey();
  remember(created);
  return created;
}

let sessionKey = storedSessionKey();

/**
 * A duplicated tab inherits `sessionStorage`, and with it the key. Each tab asks whether another
 * live tab holds its key; one that hears "mine" takes a new key. A reload keeps its key, so the
 * host's Neovim for this tab is reused rather than one more started per reload.
 */
function claimSessionKey(): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  const tab = newSessionKey();
  channel.addEventListener("message", (event: MessageEvent<unknown>) => {
    const message = event.data as { type?: string; key?: string; from?: string; to?: string };
    if (message.key !== sessionKey) return;
    if (message.type === "who" && message.from !== tab) {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel.postMessage takes no target origin; the channel is same-origin by definition
      channel.postMessage({ type: "mine", key: sessionKey, to: message.from });
    } else if (message.type === "mine" && message.to === tab) {
      sessionKey = newSessionKey();
      remember(sessionKey);
    }
  });
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel.postMessage takes no target origin; the channel is same-origin by definition
  channel.postMessage({ type: "who", key: sessionKey, from: tab });
}

claimSessionKey();

/**
 * The thread id the scratchpad's Neovim session is keyed by: one per browser tab. Neovim input
 * names only the session, so two tabs sharing one would type into whichever buffer the other
 * opened last. Separate from every real thread, so the file panel's session is never replaced.
 * Read when the overlay mounts, after a duplicated tab has had the chance to take a new key.
 */
export function scratchpadEditorThreadId(): ThreadId {
  return ThreadId.make(`mesura-scratchpad-${sessionKey}`);
}
