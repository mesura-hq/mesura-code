import { describe, expect, it } from "vite-plus/test";

import {
  decideSessionRecovery,
  MAX_AUTOMATIC_REOPENS,
  type SessionRecoveryInput,
} from "./nvimSessionRecovery.ts";

const LIVE: SessionRecoveryInput = {
  ended: null,
  attachFoundNoSession: false,
  reattachPending: false,
  openInFlight: false,
  reopensInARow: 0,
};

describe("decideSessionRecovery", () => {
  it("leaves a live session alone", () => {
    expect(decideSessionRecovery(LIVE)).toEqual({ kind: "none" });
  });

  it("reopens a thread whose session is gone, as after a server restart", () => {
    expect(decideSessionRecovery({ ...LIVE, attachFoundNoSession: true })).toEqual({
      kind: "reopen",
    });
  });

  it("waits for an open already on its way instead of sending a second one", () => {
    // The first open and the attach go out together; an attach that reaches
    // the server first finds no session. The open is what fixes that.
    expect(
      decideSessionRecovery({ ...LIVE, attachFoundNoSession: true, openInFlight: true }),
    ).toEqual({ kind: "reattach-after-open" });
  });

  it("ignores the old stream while its replacement is pending", () => {
    // What a Retry looks like: the attachment still holds `gave-up` from the
    // stream that is being replaced, and acting on it would undo the Retry.
    expect(decideSessionRecovery({ ...LIVE, ended: "gave-up", reattachPending: true })).toEqual({
      kind: "none",
    });
  });

  it("stops reopening a session that keeps disappearing", () => {
    const action = decideSessionRecovery({
      ...LIVE,
      attachFoundNoSession: true,
      reopensInARow: MAX_AUTOMATIC_REOPENS,
    });
    expect(action.kind).toBe("fallback");
  });

  it("falls back for a Neovim that kept exiting, and for a session closed on purpose", () => {
    const gaveUp = decideSessionRecovery({ ...LIVE, ended: "gave-up" });
    expect(gaveUp).toEqual({ kind: "fallback", fallback: { reason: "kept-exiting", detail: "" } });
    expect(decideSessionRecovery({ ...LIVE, ended: "closed" }).kind).toBe("fallback");
  });

  it("attaches again, without opening, when a new session took the thread over", () => {
    expect(decideSessionRecovery({ ...LIVE, ended: "replaced" })).toEqual({ kind: "reattach" });
  });

  it("waits out a server that is stopping for the reconnect to say what is missing", () => {
    expect(decideSessionRecovery({ ...LIVE, ended: "stopping" })).toEqual({ kind: "none" });
  });
});
