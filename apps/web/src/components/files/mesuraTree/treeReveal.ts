/** The reveal the tree last acted on, so an entries refresh does not replay it. */
export interface HandledReveal {
  readonly path: string;
  readonly revealId: number;
}

/**
 * Whether a selected file should be revealed in the tree now.
 *
 * The file surface names its file and bumps a reveal id when the same file
 * should be shown again (opened from search a second time). An entries refresh
 * re-renders the tree with the same pair; replaying the reveal then would close
 * an active tree search and steal focus, which is what the T3 tree learned.
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
