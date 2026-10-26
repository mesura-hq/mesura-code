import type { EditorSessionEndReason } from "@t3tools/contracts";

import type { NvimFallback } from "./nvimFallback.ts";

/**
 * What a panel does once its editor session is gone (server restart, backend replaced, or ended on
 * purpose with a reason). Where a new session is right it reopens the file, then attaches afresh,
 * in that order: an attach that reaches the server first finds no session. Pure, for the races.
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
