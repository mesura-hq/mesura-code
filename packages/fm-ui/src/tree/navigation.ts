import { isTreeDirectory, type TreeRow } from "./model.ts";
import type { TreeCommand } from "./useTreeMode.ts";

interface TreeActions {
  select(path: string): void;
  toggle(path: string): void;
  activate(index: number): void;
  page(direction: number, fraction: number): void;
  jump(end: boolean): void;
  cancel(): void;
}

function left(row: TreeRow, actions: TreeActions) {
  actions.cancel();
  if (row.expanded) actions.toggle(row.path);
  else if (row.parent) actions.select(row.parent);
}

function right(row: TreeRow, child: TreeRow | undefined, actions: TreeActions) {
  actions.cancel();
  if (!isTreeDirectory(row)) return;
  if (!row.expanded) actions.toggle(row.path);
  else if (child?.parent === row.path) actions.select(child.path);
}

export function runTreeCommand(
  command: Exclude<TreeCommand, "search" | "search-next" | "search-previous" | "flash">,
  rows: readonly TreeRow[],
  cursor: number,
  actions: TreeActions,
) {
  const row = rows[cursor];
  if (!row) return;
  const move = (delta: number) => {
    actions.cancel();
    const next = rows[Math.max(0, Math.min(rows.length - 1, cursor + delta))];
    if (next) actions.select(next.path);
  };
  const commands = {
    first: () => actions.jump(false),
    last: () => actions.jump(true),
    "half-down": () => actions.page(1, 0.5),
    "half-up": () => actions.page(-1, 0.5),
    "page-down": () => actions.page(1, 1),
    "page-up": () => actions.page(-1, 1),
    down: () => move(1),
    up: () => move(-1),
    activate: () => actions.activate(cursor),
    toggle: () => {
      actions.cancel();
      if (isTreeDirectory(row)) actions.toggle(row.path);
    },
    left: () => left(row, actions),
    right: () => right(row, rows[cursor + 1], actions),
  } satisfies Record<typeof command, () => void>;
  commands[command]();
}
