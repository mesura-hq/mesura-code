import type { ProjectFileWatchEvent } from "@t3tools/contracts";

/**
 * A watch event the panel owes but could not act on yet, because a local save
 * was in flight when it arrived.
 */
export type PendingProjectFileWatch =
  | { readonly type: "changed"; readonly revision: string }
  | { readonly type: "removed" };

/**
 * What the panel has already acted on for one watched file. `handledRevision` is null while the
 * file is gone; `baselineTaken` separates "nothing said yet" from "currently absent", which share
 * a null `handledRevision` but need opposite answers.
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
 * Decides whether one watch event should make the panel re-read the file. Pass `event` as null to
 * apply a deferred event once the save confirms. `seenRevision` is the last revision handled for
 * this path in an earlier subscription (null if never watched): it tells a baseline that confirms
 * the screen from one announcing a change made while nobody watched.
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
    // A first open's baseline is the revision just read, so reading again is waste. A returned-to
    // file was not watched meanwhile and is not re-read, so a baseline that differs from the last
    // handled revision is the only notice it changed; ignoring it lets a save write stale text back.
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
