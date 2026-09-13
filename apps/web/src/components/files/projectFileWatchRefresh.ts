import type { ProjectFileWatchEvent } from "@t3tools/contracts";

/**
 * A watch event the panel owes but could not act on yet, because a local save
 * was in flight when it arrived.
 */
export type PendingProjectFileWatch =
  | { readonly type: "changed"; readonly revision: string }
  | { readonly type: "removed" };

/**
 * What the panel has already acted on for one watched file.
 *
 * `handledRevision` is the revision whose contents the panel is showing, and is
 * null while the file is known to be gone. `baselineTaken` separates "this
 * subscription has said nothing yet" from "the file is currently absent", which
 * are both a null `handledRevision` and need opposite answers.
 */
export interface ProjectFileWatchState {
  readonly handledRevision: string | null;
  readonly pending: PendingProjectFileWatch | null;
  readonly baselineTaken: boolean;
}

export const initialProjectFileWatchState: ProjectFileWatchState = {
  handledRevision: null,
  pending: null,
  baselineTaken: false,
};

export interface ProjectFileWatchAction {
  readonly state: ProjectFileWatchState;
  readonly refresh: boolean;
}

function applyPending(pending: PendingProjectFileWatch): ProjectFileWatchState {
  return pending.type === "removed"
    ? { handledRevision: null, pending: null, baselineTaken: true }
    : { handledRevision: pending.revision, pending: null, baselineTaken: true };
}

/**
 * Decides whether one watch event should make the panel re-read the file.
 *
 * Pure, because the interesting part is the sequence rather than the wiring:
 * a baseline that must not read, a save window that must defer, and a
 * reconnect whose baseline is real news.
 *
 * Pass `event` as null to re-evaluate when only `enabled` changed, which is how
 * a deferred event is applied once the save confirms.
 *
 * `seenRevision` is the last revision this client handled for this path in an
 * earlier subscription, or null when it has never watched this file. It is what
 * separates a baseline that confirms what is on screen from one that announces
 * a change made while nobody was watching.
 */
export function nextProjectFileWatchAction(
  state: ProjectFileWatchState,
  event: ProjectFileWatchEvent | null,
  enabled: boolean,
  seenRevision: string | null = null,
): ProjectFileWatchAction {
  if (event === null) {
    // Nothing new arrived, so the only thing that can have changed is whether a
    // deferred event may now be applied.
    if (!enabled || state.pending === null) return { state, refresh: false };
    return { state: applyPending(state.pending), refresh: true };
  }

  if (event.type === "removed") {
    // Deferred like any other event while a save is in flight. Reading now
    // would replace what the user is typing with a "file not found", and the
    // save itself is about to recreate the file anyway.
    if (!enabled) return { state: { ...state, pending: { type: "removed" } }, refresh: false };
    // Read anyway: the read fails and the panel says why, which beats leaving
    // the contents of a file that no longer exists on screen.
    return { state: { handledRevision: null, pending: null, baselineTaken: true }, refresh: true };
  }

  if (!state.baselineTaken) {
    // On a file being opened for the first time, the baseline is the revision
    // the panel just read, and recording it is the whole job — reading again
    // would cost a second read of identical bytes on every file open.
    //
    // On a file being returned to, it is not. The panel holds that file's
    // contents from the last visit and does not re-read them, and nothing
    // watched the file in between, so a baseline that differs from the revision
    // last handled for this path is the only notice we will ever get that the
    // file changed while we were away. Ignoring it leaves the editor showing
    // text the file no longer has, which is worse than a wasted read: an edit
    // saved from that state writes the stale version back over the new one.
    const changedWhileAway = seenRevision !== null && seenRevision !== event.revision;
    if (changedWhileAway && !enabled) {
      return {
        state: {
          ...state,
          baselineTaken: true,
          pending: { type: "changed", revision: event.revision },
        },
        refresh: false,
      };
    }
    return {
      state: { handledRevision: event.revision, pending: null, baselineTaken: true },
      refresh: changedWhileAway,
    };
  }

  if (event.revision === state.handledRevision && state.pending === null) {
    return { state, refresh: false };
  }

  if (!enabled) {
    // A local save is in flight. Re-reading now would replace what the user is
    // typing with what is on disk. Only the newest event is kept; earlier ones
    // are superseded by definition.
    return {
      state: { ...state, pending: { type: "changed", revision: event.revision } },
      refresh: false,
    };
  }

  return {
    state: { handledRevision: event.revision, pending: null, baselineTaken: true },
    refresh: true,
  };
}
