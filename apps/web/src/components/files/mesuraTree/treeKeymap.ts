import type { TreeCommand } from "@symmetria/fm-ui/tree";

import { type Binding, commandForKey } from "./keyInput";

import type { KeyInput } from "./keyInput";

export type TreeKeyInput = KeyInput;

/**
 * The file manager's tree bindings, driven through its command port.
 *
 * Mesura Code owns every chord, so the file manager's window-level dispatcher
 * is not mounted; this table is what its `TREE` rows say, minus the ones that
 * belong to the file manager alone (tabs, hidden files, help). `Ctrl+D` and
 * `Ctrl+U` are listed even though the chat timeline's capture-phase listener
 * takes them first today; the pane-focus work scopes that listener, and the
 * tree then gets them with no change here.
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
