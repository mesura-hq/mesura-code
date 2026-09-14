import { modsOf, normaliseKey } from "@symmetria/fm-core/keys/keyEvent";
import type { Mods } from "@symmetria/fm-core/keys/types";
import type { TreeCommand } from "@symmetria/fm-ui/tree";

/**
 * A key press, as the tree's key table reads it.
 *
 * Deliberately not a DOM `KeyboardEvent`, so the table is testable without a
 * document and so the caller decides what "inside a text input" means.
 */
export interface TreeKeyInput {
  readonly key: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
  /** The search field, or any other input, owns every key while it has focus. */
  readonly inTextInput: boolean;
}

interface TreeBinding {
  readonly keys: ReadonlyArray<string>;
  readonly mods: ReadonlyArray<Mods>;
  readonly command: TreeCommand;
}

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
const BINDINGS: ReadonlyArray<TreeBinding> = [
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
  { keys: ["d"], mods: ["Ctrl"], command: "half-down" },
  { keys: ["u"], mods: ["Ctrl"], command: "half-up" },
];

export function treeCommandForKey(input: TreeKeyInput): TreeCommand | null {
  if (input.inTextInput) return null;
  // `/` is Shift+7 on a Latin-American layout and AltGr on others; the file
  // manager binds it with a wildcard, and so does this table.
  if (normaliseKey(input.key) === "/" && !input.meta) return "search";
  const mods = modsOf(input);
  if (mods === null) return null;
  const key = normaliseKey(input.key);
  const binding = BINDINGS.find(
    (candidate) => candidate.keys.includes(key) && candidate.mods.includes(mods),
  );
  return binding?.command ?? null;
}
