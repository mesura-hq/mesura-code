// A pane root with a tabindex takes focus but handles no keys, so each surface
// registers the element that owns its key handlers (tree viewport, Monaco or a
// file preview, the composer). A target reports whether focus landed, so a caller
// can fall back instead of hiding the pane the keyboard is still in.
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
