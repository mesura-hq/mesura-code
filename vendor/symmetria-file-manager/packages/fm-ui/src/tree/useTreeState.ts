import { isAncestorPath, overviewPaths } from "@symmetria/fm-core/overview/model";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { OverviewModel } from "../overview/useOverview.ts";
import { projectTree } from "./model.ts";
import { pruneTreeShape } from "./prune.ts";
import {
  revealShape,
  type TreeAnchor,
  type TreeRecord,
  type TreeShape,
  visibleFallback,
} from "./state.ts";

export function useTreeState(
  root: string,
  model: OverviewModel,
  record: TreeRecord,
  onShapeChange?: ((shape: TreeShape) => void) | undefined,
) {
  const [shape, setShape] = useState(record.shape);
  const [temporaryPath, setTemporaryPath] = useState<string | null>(null);
  // Held in a ref so a host passing a new function each render does not turn
  // every render into a shape report; the effect below fires on shape alone.
  const shapeChange = useRef(onShapeChange);
  shapeChange.current = onShapeChange;
  // Pruning re-creates the shape object even when nothing was pruned, so the
  // report compares content: a host hears about a change once.
  const reported = useRef<TreeShape | null>(null);
  useLayoutEffect(() => {
    record.shape = shape;
  }, [record, shape]);
  // Passive on purpose: `selected` changes on every cursor move, and a host
  // that persists in response must not add a pre-paint render to each key.
  useEffect(() => {
    if (reported.current && sameShape(reported.current, shape)) return;
    reported.current = shape;
    shapeChange.current?.(shape);
  }, [shape]);
  const collapsed = useMemo(
    () => effectiveCollapsed(root, model.folders, shape.preset, shape.collapsed),
    [root, model.folders, shape.preset, shape.collapsed],
  );
  const baseRows = useMemo(
    () => projectTree(root, model.folders, collapsed),
    [root, model.folders, collapsed],
  );
  const rows = useMemo(
    () =>
      temporaryPath === null
        ? baseRows
        : projectTree(
            root,
            model.folders,
            new Set(
              [...collapsed].filter(
                (path) => path === temporaryPath || !isAncestorPath(path, temporaryPath),
              ),
            ),
          ),
    [baseRows, root, model.folders, collapsed, temporaryPath],
  );
  const select = (path: string) => {
    // Initial reveals survive discovery insertions only until the user acts.
    // Keeping one after navigation reapplied the Miller cursor on every batch.
    record.pendingReveal = null;
    setShape((previous) =>
      previous.selected === path ? previous : { ...previous, selected: path },
    );
  };
  const reveal = (path: string) => {
    record.pendingReveal = path;
    setShape((previous) =>
      rows.some((row) => row.path === path)
        ? { ...previous, selected: path }
        : revealShape({ ...previous, collapsed }, path),
    );
  };
  useLayoutEffect(() => {
    setShape((previous) => {
      const pruned = pruneTreeShape(previous, root, model.folders);
      const path = record.pendingReveal;
      if (!path || !overviewPaths(root, model.folders).has(path)) return pruned;
      if (rows.some((row) => row.path === path))
        return pruned.selected === path ? pruned : { ...pruned, selected: path };
      return revealShape({ ...pruned, collapsed }, path);
    });
  }, [root, model.folders, record, rows, collapsed]);
  const toggle = (path: string) =>
    setShape((previous) => {
      const next = new Set(collapsed);
      // Search can expand a persistently collapsed ancestor. The disclosure
      // describes the projected row, so its action must follow that state.
      if (rows.find((row) => row.path === path)?.expanded) next.add(path);
      else next.delete(path);
      const selected =
        next.has(path) && isAncestorPath(path, previous.selected) ? path : previous.selected;
      return { ...previous, selected, collapsed: next, preset: null, checkpoint: null };
    });
  const preset = (next: "expanded" | "collapsed" | "restore") =>
    setShape((previous) => {
      if (next === "restore")
        return previous.checkpoint
          ? { ...previous, collapsed: previous.checkpoint, preset: null, checkpoint: null }
          : previous;
      return {
        ...previous,
        collapsed: new Set(),
        preset: next,
        checkpoint: previous.checkpoint ?? collapsed,
      };
    });
  return {
    shape,
    rows,
    baseRows,
    select,
    reveal,
    toggle,
    preset,
    chooseSearch: (path: string) => {
      setTemporaryPath(path);
      select(path);
    },
    restoreSearch: (path: string, anchor: TreeAnchor | null) => {
      setTemporaryPath(null);
      record.pendingReveal = null;
      record.anchor = anchor;
      record.restoreAnchor = true;
      select(visibleFallback(path, baseRows));
    },
  };
}

function effectiveCollapsed(
  root: string,
  folders: OverviewModel["folders"],
  preset: TreeShape["preset"],
  collapsed: TreeShape["collapsed"],
): ReadonlySet<string> {
  if (preset !== "collapsed") return collapsed;
  return new Set([...folders.keys()].filter((path) => path !== root));
}

function sameSet(a: ReadonlySet<string> | null, b: ReadonlySet<string> | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.size !== b.size) return false;
  for (const path of a) if (!b.has(path)) return false;
  return true;
}

function sameShape(a: TreeShape, b: TreeShape): boolean {
  return (
    a.selected === b.selected &&
    a.preset === b.preset &&
    sameSet(a.collapsed, b.collapsed) &&
    sameSet(a.checkpoint, b.checkpoint)
  );
}
