import type { RightPanelKind } from "~/rightPanelStore";

export type FileTreeShortcutAction =
  | "none"
  | "open-surface"
  | "show-and-focus"
  | "hide-and-focus-editor"
  | "focus-composer";

export interface FileTreeShortcutInput {
  /** A thread is open on the route; without one there is no panel to open. */
  readonly hasThread: boolean;
  /** The active right-panel surface kind, `null` when the panel is closed. */
  readonly surfaceKind: RightPanelKind | null;
  /** The tree pane of the files surface is shown. */
  readonly explorerOpen: boolean;
  /** Keyboard focus is inside the tree, its search field included. */
  readonly treeFocused: boolean;
}

/**
 * What `Ctrl+E` does, from where the developer is.
 *
 * Not focused on the tree: reach it — opening the files surface first when
 * another surface is up. Focused on the tree, from anywhere in it including
 * its search field: leave it — to the editor when a file surface is active,
 * hiding the tree, or to the composer when only the tree is shown, leaving it
 * in place because a files surface without its tree is empty. One chord, one
 * meaning per state, no wrap-around.
 */
export function decideFileTreeShortcut(input: FileTreeShortcutInput): FileTreeShortcutAction {
  if (!input.hasThread) return "none";
  if (input.surfaceKind !== "files" && input.surfaceKind !== "file") return "open-surface";
  if (!input.explorerOpen || !input.treeFocused) return "show-and-focus";
  return input.surfaceKind === "file" ? "hide-and-focus-editor" : "focus-composer";
}
