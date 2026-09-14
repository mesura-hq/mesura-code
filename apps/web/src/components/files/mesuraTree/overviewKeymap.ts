import type { OverviewCommand } from "@symmetria/fm-core/overview/navigation";

import { type Binding, commandForKey, type KeyInput } from "./keyInput";

/**
 * The file manager's overview bindings, driven through its command port.
 *
 * The rows of `OVERVIEW_ONLY` in the file manager's key registry, minus
 * `help` (the host has no help sheet) and `close` (the layer's own Escape).
 * `o` toggles a folder beside the file manager's Space, so the tree and the
 * overview fold with the same key; PageDown and PageUp pan a full viewport.
 */
const BINDINGS: ReadonlyArray<Binding<OverviewCommand>> = [
  { keys: ["h", "arrowleft"], mods: [""], command: "left" },
  { keys: ["j", "arrowdown"], mods: [""], command: "down" },
  { keys: ["k", "arrowup"], mods: [""], command: "up" },
  { keys: ["l", "arrowright"], mods: [""], command: "right" },
  { keys: ["h", "arrowleft"], mods: ["Ctrl"], command: "half-left" },
  { keys: ["j", "arrowdown", "d"], mods: ["Ctrl"], command: "half-down" },
  { keys: ["k", "arrowup", "u"], mods: ["Ctrl"], command: "half-up" },
  { keys: ["l", "arrowright"], mods: ["Ctrl"], command: "half-right" },
  { keys: ["h", "arrowleft"], mods: ["Ctrl+Shift"], command: "full-left" },
  { keys: ["j", "arrowdown"], mods: ["Ctrl+Shift"], command: "full-down" },
  { keys: ["k", "arrowup"], mods: ["Ctrl+Shift"], command: "full-up" },
  { keys: ["l", "arrowright"], mods: ["Ctrl+Shift"], command: "full-right" },
  { keys: ["pagedown"], mods: [""], command: "full-down" },
  { keys: ["pageup"], mods: [""], command: "full-up" },
  { keys: ["+", "="], mods: ["Symbol"], command: "zoom-in" },
  { keys: ["-"], mods: ["Symbol"], command: "zoom-out" },
  { keys: ["0"], mods: [""], command: "reset" },
  { keys: ["m"], mods: ["Alt"], command: "toggle-minimap" },
  { keys: ["f"], mods: [""], command: "fit" },
  { keys: ["o", " "], mods: [""], command: "toggle" },
  { keys: ["s"], mods: [""], command: "flash" },
  { keys: ["/"], mods: ["Symbol"], command: "search" },
  { keys: ["n"], mods: [""], command: "search-next" },
  { keys: ["n"], mods: ["Shift"], command: "search-previous" },
  { keys: ["enter"], mods: [""], command: "reveal" },
];

export function overviewCommandForKey(input: KeyInput): OverviewCommand | null {
  return commandForKey(BINDINGS, input);
}
