import { isAncestorPath, overviewPaths } from "@symmetria/fm-core/overview/model";
import { useLayoutEffect, useMemo, useState } from "react";
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

export function useTreeState(root: string, model: OverviewModel, record: TreeRecord) {
  const [shape, setShape] = useState(record.shape);
  const [temporaryPath, setTemporaryPath] = useState<string | null>(null);
  useLayoutEffect(() => {
    record.shape = shape;
  }, [record, shape]);
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
