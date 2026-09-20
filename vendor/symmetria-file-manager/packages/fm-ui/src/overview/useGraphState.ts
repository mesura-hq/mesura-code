import type { GraphGroup } from "@symmetria/fm-core/overview/layout";
import { type OverviewFolder, overviewPaths } from "@symmetria/fm-core/overview/model";
import { parentOf } from "@symmetria/fm-core/pane";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { OverviewModel } from "./useOverview.ts";

function survivingSelection(
  folders: ReadonlyMap<string, OverviewFolder>,
  root: string,
  selected: string,
): string {
  const paths = overviewPaths(root, folders);
  let path = selected;
  while (!paths.has(path) && path !== parentOf(path)) path = parentOf(path);
  return paths.has(path) ? path : root;
}
export function useGraphState(root: string, model: OverviewModel) {
  const initial = useRef(model.view);
  const [collapsed, setCollapsed] = useState(new Set(initial.current?.collapsed));
  const [selected, setSelected] = useState(initial.current?.selected ?? root);
  const [zoom, setZoom] = useState(initial.current?.zoom ?? 1);
  const [origin, setOrigin] = useState(initial.current?.origin ?? { x: 0, y: 0 });
  useEffect(() => {
    if (model.folders.size === 0) return;
    setSelected((current) => survivingSelection(model.folders, root, current));
    setCollapsed((current) => {
      const next = new Set([...current].filter((path) => model.folders.has(path)));
      return next.size === current.size ? current : next;
    });
  }, [model.folders, root]);
  return {
    collapsed,
    setCollapsed,
    selected,
    setSelected,
    zoom,
    setZoom,
    origin,
    setOrigin,
    initial: initial.current,
  };
}
export function useRememberGraph(
  model: OverviewModel,
  state: ReturnType<typeof useGraphState>,
  viewport: RefObject<HTMLDivElement | null>,
  boxes: RefObject<Map<string, GraphGroup>>,
) {
  const latest = useRef({ model, state });
  latest.current = { model, state };
  const saveForNode = useCallback(
    (node: HTMLDivElement | null) => {
      const { model, state } = latest.current;
      model.saveView?.({
        selected: state.selected,
        collapsed: new Set(state.collapsed),
        zoom: state.zoom,
        origin: state.origin,
        scroll: { x: node?.scrollLeft ?? 0, y: node?.scrollTop ?? 0 },
        boxes: new Map(
          [...boxes.current].map(([path, { x, y, width, height }]) => [
            path,
            { x, y, width, height },
          ]),
        ),
      });
    },
    [boxes],
  );
  // Passive cleanup reads detached nodes with zero scroll offsets. Save during
  // layout cleanup while the viewport still belongs to the document.
  useLayoutEffect(() => {
    const node = viewport.current;
    const save = () => saveForNode(node);
    node?.addEventListener("scroll", save);
    return () => {
      save();
      node?.removeEventListener("scroll", save);
    };
  }, [viewport, saveForNode]);
  useEffect(() => saveForNode(viewport.current));
}
