import type { EditorSessionEndReason } from "@t3tools/contracts";

import type { NvimFallback } from "./nvimFallback.ts";

/**
 * What a panel does once its editor session is gone.
 *
 * A session goes with the server that held it — a restart, the desktop app
 * replacing its backend — and the server also ends one on purpose, saying why.
 * The client holds what a new session needs — the file, the project, the text
 * on screen — so where a new session is the right answer it opens the file
 * again, and then attaches afresh, because the old stream has ended or failed
 * for good. In that order: an attachment that reaches the server first finds no
 * session and fails again.
 *
 * Pure, and apart from the hook, because this is the part with the races in it
 * and each case here is one the hook met: an attach that loses the race with
 * the first open, a reopen that fails, a server that keeps dropping the session.
 */

/** How many reopens in a row, with no session answering in between, before falling back. */
export const MAX_AUTOMATIC_REOPENS = 3;

export interface SessionRecoveryInput {
  /** Why the session ended, when the server said so. */
  readonly ended: EditorSessionEndReason | null;
  /** The attachment failed because the thread has no session at all. */
  readonly attachFoundNoSession: boolean;
  /**
   * The attachment is already going to be replaced after an open lands, so
   * what it says now describes the stream that is going away.
   */
  readonly reattachPending: boolean;
  /** An open is on its way to the server. */
  readonly openInFlight: boolean;
  /** Reopens since a session last answered. */
  readonly reopensInARow: number;
}

export type SessionRecoveryAction =
  | { readonly kind: "none" }
  /** Attach again now: a session exists, the stream just is not on it. */
  | { readonly kind: "reattach" }
  /** Attach again once the open already on its way has landed. */
  | { readonly kind: "reattach-after-open" }
  /** Open the file again, then attach. */
  | { readonly kind: "reopen" }
  | { readonly kind: "fallback"; readonly fallback: NvimFallback };

const NONE: SessionRecoveryAction = { kind: "none" };

export function decideSessionRecovery(input: SessionRecoveryInput): SessionRecoveryAction {
  if (input.reattachPending) return NONE;
  switch (input.ended) {
    case "gave-up":
      // A Neovim that kept exiting would only exit again.
      return { kind: "fallback", fallback: { reason: "kept-exiting", detail: "" } };
    case "closed":
      // Closed on purpose, so bringing it back would undo somebody's decision.
      return { kind: "fallback", fallback: { reason: "session-lost", detail: "it was closed" } };
    case "replaced":
      return { kind: "reattach" };
    case "stopping":
      // The reconnect's attach is what says whether anything needs reopening.
      return NONE;
    case null:
      break;
  }
  if (!input.attachFoundNoSession) return NONE;
  // The first open and the attach go out together, and the attach can win.
  if (input.openInFlight) return { kind: "reattach-after-open" };
  if (input.reopensInARow >= MAX_AUTOMATIC_REOPENS) {
    return {
      kind: "fallback",
      fallback: { reason: "session-lost", detail: "it kept ending after being reopened" },
    };
  }
  return { kind: "reopen" };
}
