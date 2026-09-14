import { joinPath, parentOf } from "../pane.ts";
import type { OverviewFolder } from "./model.ts";
export type Direction = "up" | "down" | "left" | "right";
export type OverviewCommand =
  | Direction
  | `half-${Direction}`
  | `full-${Direction}`
  | "zoom-in"
  | "zoom-out"
  | "reset"
  | "fit"
  | "toggle"
  | "flash"
  | "search"
  | "search-next"
  | "search-previous"
  | "help"
  | "reveal"
  | "toggle-minimap";
export function moveSelection(
  folders: ReadonlyMap<string, OverviewFolder>,
  root: string,
  selected: string,
  direction: Direction,
): string {
  if (direction === "left") return selected === root ? root : parentOf(selected);
  if (direction === "right") {
    const child = folders.get(selected)?.entries[0];
    return child ? joinPath(selected, child.name) : selected;
  }
  const parent = folders.get(parentOf(selected));
  if (!parent || selected === root) return selected;
  const index = parent.entries.findIndex((entry) => joinPath(parent.path, entry.name) === selected);
  const next = parent.entries[index + (direction === "down" ? 1 : -1)];
  return next ? joinPath(parent.path, next.name) : selected;
}
