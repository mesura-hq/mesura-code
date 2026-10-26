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
 * What `Ctrl+E` does. Outside the tree it reaches the tree, opening the files surface
 * first. Inside it (search field included) it leaves: to the editor, hiding the tree, or
 * to the composer with the tree kept, because a files surface without its tree is empty.
 */
export function decideFileTreeShortcut(input: FileTreeShortcutInput): FileTreeShortcutAction {
  if (!input.hasThread) return "none";
  if (input.surfaceKind !== "files" && input.surfaceKind !== "file") return "open-surface";
  if (!input.explorerOpen || !input.treeFocused) return "show-and-focus";
  return input.surfaceKind === "file" ? "hide-and-focus-editor" : "focus-composer";
}
