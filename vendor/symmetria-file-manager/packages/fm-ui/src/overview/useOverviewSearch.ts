import type { GraphGroup } from "@symmetria/fm-core/overview/layout";
import { type OverviewFolder, overviewPaths } from "@symmetria/fm-core/overview/model";
import type { Point } from "@symmetria/fm-core/overview/viewport";
import { parentOf } from "@symmetria/fm-core/pane";
import { type RefObject, useMemo, useRef } from "react";
import { useSearchSession } from "../useSearch.ts";

export function useOverviewSearch({
  root,
  folders,
  selected,
  viewport,
  select,
  restore,
}: {
  root: string;
  folders: ReadonlyMap<string, OverviewFolder>;
  selected: string;
  viewport: RefObject<HTMLDivElement | null>;
  select: (path: string) => void;
  restore: (path: string, point: Point) => void;
}) {
  const targets = useMemo(
    () => [...overviewPaths(root, folders)].sort().map((path) => ({ key: path, text: path })),
    [root, folders],
  );
  const camera = useRef({ x: 0, y: 0 });
  const session = useSearchSession({
    targets,
    scope: root,
    selected,
    choose: select,
    capture: () => {
      camera.current = {
        x: viewport.current?.scrollLeft ?? 0,
        y: viewport.current?.scrollTop ?? 0,
      };
    },
    restore: (path) =>
      restore(targets.some((target) => target.key === path) ? path : selected, camera.current),
  });
  const focus = () =>
    viewport.current?.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true });
  return {
    ...session,
    confirm: () => {
      session.confirm();
      focus();
    },
    cancel: () => {
      session.cancel();
      focus();
    },
    clear: () => {
      session.clear();
      focus();
    },
  };
}

/** Each path contributes once to its closest represented group. */
export function useMinimapMatches(
  shown: readonly GraphGroup[],
  matches: ReadonlySet<string>,
  selected: string,
) {
  return useMemo(() => {
    const groups = new Set(shown.map((group) => group.path));
    const counts = new Map<string, { count: number; current: boolean }>();
    for (const match of matches) {
      let path = match;
      while (!groups.has(path) && parentOf(path) !== path) path = parentOf(path);
      if (!groups.has(path)) continue;
      const count = counts.get(path) ?? { count: 0, current: false };
      count.count += 1;
      if (match === selected) count.current = true;
      counts.set(path, count);
    }
    return counts;
  }, [shown, matches, selected]);
}
