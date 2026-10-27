/** The reveal the tree last acted on, so an entries refresh does not replay it. */
export interface HandledReveal {
  readonly path: string;
  readonly revealId: number;
}

/**
 * Whether a selected file should be revealed now. A new reveal id asks to show the same
 * file again; an entries refresh re-renders with the same pair, and replaying it then
 * would close an active tree search and steal focus.
 */
export function nextRevealRequest(
  handled: HandledReveal | null,
  selectedPath: string | null,
  revealId: number,
): { readonly reveal: boolean; readonly handled: HandledReveal | null } {
  if (selectedPath === null) return { reveal: false, handled: null };
  if (handled !== null && handled.path === selectedPath && handled.revealId === revealId) {
    return { reveal: false, handled };
  }
  return { reveal: true, handled: { path: selectedPath, revealId } };
}
