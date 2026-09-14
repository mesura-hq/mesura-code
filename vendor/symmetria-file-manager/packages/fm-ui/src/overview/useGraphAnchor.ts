import type { GraphGroup } from "@symmetria/fm-core/overview/layout";
import { joinPath } from "@symmetria/fm-core/pane";
import { type RefObject, useLayoutEffect, useRef } from "react";
export function useGraphAnchor(
  groups: readonly GraphGroup[],
  selected: string,
  zoom: number,
  viewport: RefObject<HTMLDivElement | null>,
  extent: RefObject<HTMLDivElement | null>,
) {
  const anchor = useRef<{ selection: string; path: string; x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const group =
      groups.find((item) => item.path === selected) ??
      groups.find((item) =>
        item.entries.some((entry) => joinPath(item.path, entry.name) === selected),
      );
    if (!group) return;
    const previous = anchor.current;
    const node = viewport.current;
    if (node && previous?.selection === selected && previous.path === group.path) {
      const x = node.scrollLeft + (group.x - previous.x) * zoom;
      const y = node.scrollTop + (group.y - previous.y) * zoom;
      // A last group has no content below it. Reserve trailing camera space
      // before scrolling so the browser does not clamp away the retained anchor.
      if (extent.current) {
        extent.current.style.minWidth = `${Math.max(0, x) + node.clientWidth}px`;
        extent.current.style.minHeight = `${Math.max(0, y) + node.clientHeight}px`;
      }
      node.scrollLeft = x;
      node.scrollTop = y;
    }
    anchor.current = { selection: selected, path: group.path, x: group.x, y: group.y };
  }, [groups, selected, zoom, viewport, extent]);
}
