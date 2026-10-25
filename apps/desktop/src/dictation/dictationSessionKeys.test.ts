/**
 * Entry point: `createDictationSessionKeys`, which `DesktopDictationWidget` drives from the
 * renderer's published dictation state and tears down on quit. The socket and the binds are
 * recording stand-ins; a socket start is held open with a promise the spec releases.
 *
 * Search unification, phase 4, review finding P1-1, and the regressions for socket-only-under-
 * Hyprland and the launcher fallback.
 */
import { describe, expect, it } from "vite-plus/test";

import { createDictationSessionKeys } from "./dictationSessionKeys.ts";

function makeSession(input: { readonly hyprland?: boolean; readonly listens?: boolean } = {}) {
  const events: string[] = [];
  const heldStarts: Array<(listening: boolean) => void> = [];
  const keys = createDictationSessionKeys({
    binds: {
      enabled: input.hyprland ?? true,
      setSessionActive: async (active, socketListening) => {
        events.push(active ? `binds on (socket ${String(socketListening)})` : "binds off");
      },
    },
    setSocketActive: (active) => {
      if (!active) {
        events.push("socket off");
        return Promise.resolve(false);
      }
      events.push("socket starting");
      return new Promise<boolean>((resolve) => {
        heldStarts.push((listening) => {
          events.push(listening ? "socket listening" : "socket failed");
          resolve(listening);
        });
      });
    },
  });
  /** Lets the socket start that is being held finish. */
  const releaseStart = async (listening = input.listens ?? true) => {
    // The start begins once the queue reaches it.
    await Promise.resolve();
    heldStarts.shift()?.(listening);
  };
  return { keys, events, releaseStart };
}

describe("search unification phase 4 rework: dictation session keys", () => {
  it("search unification phase 4 rework P1-1: quitting while the socket starts leaves no binds and no socket", async () => {
    const { keys, events, releaseStart } = makeSession();
    keys.setLive(true);
    const disposed = keys.dispose();
    await releaseStart();
    await disposed;
    keys.setLive(false);
    keys.setLive(true);
    await releaseStart();
    expect(events).toEqual([
      "socket starting",
      "socket listening",
      "binds on (socket true)",
      "binds off",
      "socket off",
    ]);
  });

  it("search unification phase 4 regression: a session starts the socket before the binds and ends the binds before the socket", async () => {
    const { keys, events, releaseStart } = makeSession();
    keys.setLive(true);
    await releaseStart();
    keys.setLive(false);
    await keys.dispose();
    expect(events).toEqual([
      "socket starting",
      "socket listening",
      "binds on (socket true)",
      "binds off",
      "socket off",
    ]);
  });

  it("search unification phase 4 regression: a socket that cannot listen leaves the keys on the launcher", async () => {
    const { keys, events, releaseStart } = makeSession({ listens: false });
    keys.setLive(true);
    await releaseStart();
    await keys.dispose();
    expect(events.slice(0, 3)).toEqual([
      "socket starting",
      "socket failed",
      "binds on (socket false)",
    ]);
  });

  it("search unification phase 4 regression: outside Hyprland no socket is started", async () => {
    const { keys, events } = makeSession({ hyprland: false });
    keys.setLive(true);
    keys.setLive(false);
    await keys.dispose();
    expect(events).toEqual([]);
  });
});
