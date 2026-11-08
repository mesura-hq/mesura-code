import type { TreeCommand } from "@symmetria/fm-ui/tree";

import { type Binding, commandForKey } from "./keyInput";

import type { KeyInput } from "./keyInput";

export type TreeKeyInput = KeyInput;

/**
 * The file manager's `TREE` bindings minus its own (tabs, hidden files, help); its
 * window-level dispatcher is not mounted. The chat timeline's capture-phase listener
 * still takes `Ctrl+D` and `Ctrl+U` first; once pane focus scopes it, they reach the tree.
 */
const BINDINGS: ReadonlyArray<Binding<TreeCommand>> = [
  { keys: ["j", "arrowdown"], mods: [""], command: "down" },
  { keys: ["k", "arrowup"], mods: [""], command: "up" },
  { keys: ["h", "arrowleft"], mods: [""], command: "left" },
  { keys: ["l", "arrowright"], mods: [""], command: "right" },
  { keys: ["o"], mods: [""], command: "toggle" },
  { keys: ["enter"], mods: [""], command: "activate" },
  { keys: ["g"], mods: ["Shift"], command: "last" },
  { keys: ["home"], mods: [""], command: "first" },
  { keys: ["end"], mods: [""], command: "last" },
  { keys: ["pagedown"], mods: [""], command: "page-down" },
  { keys: ["pageup"], mods: [""], command: "page-up" },
  { keys: ["n"], mods: [""], command: "search-next" },
  { keys: ["n"], mods: ["Shift"], command: "search-previous" },
  { keys: ["s"], mods: [""], command: "flash" },
  { keys: ["/"], mods: ["Symbol"], command: "search" },
  { keys: ["d"], mods: ["Ctrl"], command: "half-down" },
  { keys: ["u"], mods: ["Ctrl"], command: "half-up" },
];

export function treeCommandForKey(input: TreeKeyInput): TreeCommand | null {
  return commandForKey(BINDINGS, input);
}
