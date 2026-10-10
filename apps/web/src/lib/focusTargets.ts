/**
 * Where focus lands when a chord sends it somewhere.
 *
 * A pane root with a tabindex receives focus and then eats nothing, so each
 * surface registers the element that owns its key handlers: the tree its
 * viewport, the editor Monaco's `focus()` (or a file preview's scroll region,
 * which shows in the editor's place), the chat its composer. A target
 * reports whether focus actually landed, so a caller can fall back instead of
 * hiding the pane the keyboard is still in. The pane-focus design (ADR-004)
 * consumes this registry for its own moves.
 */
export type FocusTargetName = "tree" | "editor" | "composer";

const targets = new Map<FocusTargetName, () => boolean>();

export function registerFocusTarget(name: FocusTargetName, focus: () => boolean): () => void {
  targets.set(name, focus);
  return () => {
    if (targets.get(name) === focus) targets.delete(name);
  };
}

/** Focuses the target; false when none is registered or it had nothing to focus. */
export function focusTarget(name: FocusTargetName): boolean {
  return targets.get(name)?.() ?? false;
}

export function isFileTreeFocused(): boolean {
  const active = document.activeElement;
  return active instanceof Element && active.closest("[data-mesura-file-tree]") !== null;
}
