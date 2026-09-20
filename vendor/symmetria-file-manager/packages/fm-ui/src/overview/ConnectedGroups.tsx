import {
  type Box,
  type GraphGroup,
  graphBounds,
  intersects,
  visibleGroups,
} from "@symmetria/fm-core/overview/layout";
import { joinPath } from "@symmetria/fm-core/pane";
import {
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { OverviewControls } from "./OverviewControls.tsx";
import { OverviewFlash } from "./OverviewFlash.tsx";
import { OverviewGraphViewport } from "./OverviewGraphViewport.tsx";
import { OverviewMinimap } from "./OverviewMinimap.tsx";
import { OverviewSearch } from "./OverviewSearch.tsx";
import { useGraphAnchor } from "./useGraphAnchor.ts";
import { useGraphCommands } from "./useGraphCommands.ts";
import { useGraphScene } from "./useGraphScene.ts";
import { useGraphState, useRememberGraph } from "./useGraphState.ts";
import type { useOverview } from "./useOverview.ts";
import { useOverviewFlash } from "./useOverviewFlash.ts";
import type { OverviewPort } from "./useOverviewMode.ts";
import { useOverviewSearch } from "./useOverviewSearch.ts";
export function ConnectedGroups({
  root,
  model,
  port,
  renderToolbar = renderControls,
  minimapVisible = true,
  onToggleMinimap,
}: {
  readonly minimapVisible?: boolean;
  readonly onToggleMinimap?: () => void;
  readonly root: string;
  readonly model: ReturnType<typeof useOverview>;
  readonly port?: OverviewPort;
  readonly renderToolbar?: (controls: ReactNode) => ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const extent = useRef<HTMLDivElement>(null);
  const state = useGraphState(root, model);
  const { collapsed, setCollapsed, selected, setSelected, zoom, setZoom, origin, setOrigin } =
    state;
  const [scroll, sample] = useViewportSample(viewport, extent, state.initial?.scroll);
  const { groups, boxes, onMeasure, rearrange } = useGraphScene(
    model.folders,
    state.initial?.boxes,
  );
  useRememberGraph(model, state, viewport, boxes);
  const { shown, bounds } = useVisibleGraph(groups, collapsed);
  const windowBox = graphWindow(scroll, origin, zoom);
  useGraphAnchor(groups, selected, zoom, viewport, extent);
  const mounted = groupsInViewport(shown, windowBox, zoom, selected);
  const commands = useGraphCommands({
    root,
    model,
    selected,
    setSelected,
    collapsed,
    setCollapsed,
    viewport,
    zoom,
    setZoom,
    origin,
    setOrigin,
    extent,
    bounds,
    port,
    flash: () => flash.open(),
    search: () => search.open(),
    searchNext: () => search.goNext(),
    searchPrevious: () => search.goPrevious(),
  });
  const search = useOverviewSearch({
    root,
    folders: model.folders,
    selected,
    viewport,
    select: commands.select,
    restore: commands.restore,
  });
  const generation = useMemo(
    () => graphGeneration(groups, collapsed, zoom, origin),
    [groups, collapsed, zoom, origin],
  );
  const flash = useOverviewFlash({
    viewport,
    generation,
    port,
    stopCamera: commands.cancel,
    select: commands.select,
  });
  const matches = activeMatches(flash, search);
  const onScroll = () => {
    flash.cancel();
    sample();
  };
  const backgroundDrag = useBackgroundDrag(commands.cancel, sample);
  const controls = (
    <OverviewControls
      minimapVisible={minimapVisible}
      onToggleMinimap={onToggleMinimap}
      zoom={zoom}
      run={commands.run}
      selected={selected}
      canFocus={model.folders.has(selected)}
      onFocus={focusFolder(port, selected)}
      onRearrange={rearrange}
    />
  );
  return (
    <>
      {renderSearch(search, flash.active)}
      {renderToolbar(controls)}
      <div className="overview-graph-frame" data-flash-mode={flash.active}>
        <OverviewGraphViewport
          viewport={viewport}
          extent={extent}
          bounds={bounds}
          origin={origin}
          zoom={zoom}
          selected={selected}
          onScroll={onScroll}
          backgroundDrag={backgroundDrag}
          shown={shown}
          boxes={boxes.current}
          windowBox={windowBox}
          mounted={mounted}
          matches={matches}
          collapsed={collapsed}
          onSelect={commands.select}
          onToggle={commands.toggle}
          onMeasure={onMeasure}
          onInclude={model.include}
          onWheel={commands.cancel}
        />
        <OverviewFlash flash={flash} />
        <OverviewMinimap
          matches={matches}
          selected={selected}
          visible={minimapVisible}
          shown={shown}
          bounds={bounds}
          windowBox={windowBox}
          viewportSize={scroll}
          onNavigate={commands.moveTo}
          onCancel={commands.cancel}
        />
      </div>
    </>
  );
}

function groupsInViewport(
  shown: readonly GraphGroup[],
  windowBox: Box,
  zoom: number,
  selected: string,
) {
  return shown.filter(
    (group) =>
      intersects(group, windowBox, 200 / zoom) ||
      group.path === selected ||
      group.entries.some((entry) => joinPath(group.path, entry.name) === selected),
  );
}

function useViewportSample(
  viewport: RefObject<HTMLDivElement | null>,
  extent: RefObject<HTMLDivElement | null>,
  restored: { x: number; y: number } | undefined,
) {
  const initialScroll = useRef(restored);
  const [scroll, setScroll] = useState({ x: 0, y: 0, width: 1200, height: 800 });
  const sample = useCallback(() => {
    const node = viewport.current;
    if (node)
      setScroll({
        x: node.scrollLeft,
        y: node.scrollTop,
        width: node.clientWidth,
        height: node.clientHeight,
      });
  }, [viewport]);
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    if (initialScroll.current) {
      // Restore trailing space before cached offsets; native scroll otherwise clamps them.
      if (extent.current) {
        extent.current.style.minWidth = `${initialScroll.current.x + node.clientWidth}px`;
        extent.current.style.minHeight = `${initialScroll.current.y + node.clientHeight}px`;
      }
      node.scrollLeft = initialScroll.current.x;
      node.scrollTop = initialScroll.current.y;
    }
    sample();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sample);
    observer.observe(node);
    return () => observer.disconnect();
  }, [viewport, extent, sample]);
  return [scroll, sample] as const;
}

function useBackgroundDrag(cancel: () => void, sample: () => void) {
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const stop = () => {
    drag.current = null;
  };
  return {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (
        event.button !== 0 ||
        (event.target instanceof Element && event.target.closest("button,section,details"))
      )
        return;
      cancel();
      const node = event.currentTarget;
      drag.current = {
        x: event.clientX,
        y: event.clientY,
        left: node.scrollLeft,
        top: node.scrollTop,
      };
      node.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const start = drag.current;
      if (!start) return;
      event.currentTarget.scrollLeft = start.left + start.x - event.clientX;
      event.currentTarget.scrollTop = start.top + start.y - event.clientY;
      sample();
    },
    onPointerUp: stop,
    onPointerCancel: stop,
  };
}

function graphWindow(scroll: Box, origin: { x: number; y: number }, zoom: number): Box {
  return {
    x: (scroll.x - origin.x) / zoom,
    y: (scroll.y - origin.y) / zoom,
    width: (scroll.width || 1200) / zoom,
    height: (scroll.height || 800) / zoom,
  };
}

function graphGeneration(
  groups: readonly GraphGroup[],
  collapsed: ReadonlySet<string>,
  zoom: number,
  origin: { x: number; y: number },
) {
  return JSON.stringify([groups, [...collapsed], zoom, origin]);
}

function activeMatches(
  flash: ReturnType<typeof useOverviewFlash>,
  search: ReturnType<typeof useOverviewSearch>,
) {
  return flash.active ? flash.matches : search.matches;
}
function renderSearch(search: ReturnType<typeof useOverviewSearch>, flashActive: boolean) {
  return flashActive ? null : <OverviewSearch search={search} />;
}

function renderControls(controls: ReactNode) {
  return controls;
}
function focusFolder(port: OverviewPort | undefined, path: string) {
  return () => port?.focus(path);
}

function useVisibleGraph(groups: readonly GraphGroup[], collapsed: ReadonlySet<string>) {
  return useMemo(() => {
    const shown = visibleGroups(groups, collapsed);
    return { shown, bounds: graphBounds(shown) };
  }, [groups, collapsed]);
}
