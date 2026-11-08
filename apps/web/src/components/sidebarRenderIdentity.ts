// Mesura: keeps the sidebar's render inputs the same objects across a streamed
// shell update that changes no row's place, so dnd-kit and the row wrappers
// skip the threads that did not change (phase 6 of the editor latency cycle).
import type { ReactElement } from "react";

import type { SidebarListItem, SidebarListMarker, SidebarSection } from "./Sidebar.logic";

/** The settled drop order while nothing is dragged. */
export const NO_DRAGGED_ORDER: readonly string[] = [];

const FIELD = "\u0001";
const ITEM = "\u0000";

/** A string equal for two item lists exactly when they have the same structure. */
export function sidebarListItemsIdentityKey(items: readonly SidebarListItem[]): string {
  return items
    .map((item) =>
      item.kind === "thread"
        ? `t${FIELD}${item.key}${FIELD}${item.section}`
        : `m${FIELD}${item.marker}`,
    )
    .join(ITEM);
}

/** The items `sidebarListItemsIdentityKey` encoded, as one array per key. */
export function sidebarListItemsFromIdentityKey(key: string): readonly SidebarListItem[] {
  if (key === "") return [];
  return key.split(ITEM).map((encoded): SidebarListItem => {
    const [kind, first, second] = encoded.split(FIELD);
    return kind === "t"
      ? { kind: "thread", key: first!, section: second as SidebarSection }
      : { kind: "marker", marker: first as SidebarListMarker };
  });
}

/**
 * `memo` equality for the sidebar's sortable row wrapper: its own props by
 * identity, and the row element it wraps by type, key and shallow props, the
 * same test the memoized row applies to itself. So the wrapper renders exactly
 * when the row would, and drag state still reaches it through dnd-kit's context.
 */
export function sameSortableRowProps<Props extends { readonly row: ReactElement }>(
  previous: Props,
  next: Props,
): boolean {
  // Allocation-free: this runs for every row on every sidebar render.
  let ownKeys = 0;
  for (const key in previous) {
    ownKeys++;
    if (key !== "row" && (!(key in next) || !Object.is(previous[key], next[key]))) return false;
  }
  for (const _key in next) ownKeys--;
  if (ownKeys !== 0) return false;
  const previousRow = previous.row;
  const nextRow = next.row;
  if (previousRow === nextRow) return true;
  if (previousRow.type !== nextRow.type || previousRow.key !== nextRow.key) return false;
  return sameShallowProps(
    previousRow.props as Record<string, unknown>,
    nextRow.props as Record<string, unknown>,
  );
}

function sameShallowProps(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  let keys = 0;
  for (const key in previous) {
    keys++;
    if (!(key in next) || !Object.is(previous[key], next[key])) return false;
  }
  for (const _key in next) keys--;
  return keys === 0;
}
