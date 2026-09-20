import type { Box, GraphGroup } from "@symmetria/fm-core/overview/layout";
import {
  type MinimapProjection,
  minimapProjection,
  minimapWorldPoint,
  type Point,
  projectMinimapViewport,
  type Size,
} from "@symmetria/fm-core/overview/viewport";
import {
  memo,
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { OverviewLinks } from "./OverviewLinks.tsx";
import { useMinimapMatches } from "./useOverviewSearch.ts";

const MinimapGeometry = memo(function MinimapGeometry({
  shown,
  bounds,
}: {
  readonly shown: readonly GraphGroup[];
  readonly bounds: Box;
}) {
  const boxes = useMemo(() => new Map(shown.map((group) => [group.path, group])), [shown]);
  return (
    <g className="minimap-geometry">
      <OverviewLinks
        shown={shown}
        boxes={boxes}
        bounds={bounds}
        windowBox={bounds}
        zoom={1}
        selected=""
      />
      {shown.map((group) => (
        <rect
          key={group.path}
          data-minimap-group={group.path}
          x={group.x}
          y={group.y}
          width={group.width}
          height={group.height}
        />
      ))}
    </g>
  );
});

const NO_MATCHES: ReadonlySet<string> = new Set();

export function OverviewMinimap({
  matches = NO_MATCHES,
  selected = "",
  visible,
  shown,
  bounds,
  windowBox,
  viewportSize,
  onNavigate,
  onCancel,
}: {
  readonly matches?: ReadonlySet<string>;
  readonly selected?: string;
  readonly shown: readonly GraphGroup[];
  readonly bounds: Box;
  readonly windowBox: Box;
  readonly viewportSize: Size;
  readonly visible: boolean;
  readonly onNavigate: (point: Point, animated: boolean) => (() => void) | undefined;
  readonly onCancel: () => void;
}) {
  const descriptionId = useId();
  const counts = useMinimapMatches(shown, matches, selected);
  const description = [...counts]
    .map(([path, result]) => `${path}: ${result.count}${result.current ? " (current result)" : ""}`)
    .join("; ");
  const { width, height } = viewportSize;
  const { width: graphWidth, height: graphHeight } = bounds;
  const projection = useMemo(
    () => minimapProjection({ width: graphWidth, height: graphHeight }, { width, height }),
    [graphWidth, graphHeight, width, height],
  );
  const pointer = useMinimapPointer(projection, windowBox, onNavigate, onCancel, visible);
  if (!visible || !projection) return null;
  const indicator = projectMinimapViewport(windowBox, projection);
  return (
    <div className="overview-minimap-surface">
      <svg
        {...pointer}
        className="overview-minimap"
        role="img"
        aria-label="Folder overview minimap"
        aria-describedby={descriptionId}
        width={projection.width}
        height={projection.height}
        viewBox={`0 0 ${projection.width} ${projection.height}`}
      >
        <title>Folder overview minimap</title>
        <desc id={descriptionId}>
          {matches.size} matching paths in {counts.size} groups. {description}
        </desc>
        <g
          transform={`translate(${projection.offset.x} ${projection.offset.y}) scale(${projection.scale})`}
        >
          <MinimapGeometry shown={shown} bounds={bounds} />
        </g>
        <g className="minimap-search-matches" pointerEvents="none">
          {shown.flatMap((group) => {
            const result = counts.get(group.path);
            return result
              ? [
                  <circle
                    key={group.path}
                    data-minimap-match-group={group.path}
                    data-minimap-matches={result.count}
                    data-current={result.current}
                    cx={projection.offset.x + (group.x + group.width / 2) * projection.scale}
                    cy={projection.offset.y + (group.y + group.height / 2) * projection.scale}
                    r={result.current ? 3 : 2}
                  >
                    <title>
                      {group.path}: {result.count} matching paths
                      {result.current ? ", current result" : ""}
                    </title>
                  </circle>,
                ]
              : [];
          })}
        </g>
        <rect
          data-minimap-viewport=""
          className="minimap-viewport"
          x={indicator.x}
          y={indicator.y}
          width={indicator.width}
          height={indicator.height}
        />
        {indicator.outside ? (
          <circle className="minimap-outside" cx={indicator.x} cy={indicator.y} r={3} />
        ) : null}
      </svg>
    </div>
  );
}

function useMinimapPointer(
  projection: MinimapProjection | null,
  windowBox: Box,
  navigate: (point: Point, animated: boolean) => (() => void) | undefined,
  cancel: () => void,
  visible: boolean,
) {
  const ref = useRef<SVGSVGElement>(null);
  const drag = useRef<{ pointerId: number; offset: Point | null } | null>(null);
  const motion = useRef<(() => void) | undefined>(undefined);
  const stop = useCallback((cancelMotion: boolean) => {
    const active = drag.current;
    drag.current = null;
    if (cancelMotion) {
      motion.current?.();
      motion.current = undefined;
    }
    const node = ref.current;
    if (active && node?.hasPointerCapture(active.pointerId))
      node.releasePointerCapture(active.pointerId);
  }, []);
  useEffect(() => {
    if (!visible) stop(true);
    return () => stop(true);
  }, [stop, visible]);
  const previous = useRef({ projection, width: windowBox.width, height: windowBox.height });
  useLayoutEffect(() => {
    const old = previous.current;
    // Card measurement can replace group objects without changing map coordinates.
    // Cancelling on object identity stopped both far clicks and sustained drags.
    if (
      old.projection !== projection ||
      old.width !== windowBox.width ||
      old.height !== windowBox.height
    ) {
      if (drag.current?.offset) stop(false);
      previous.current = { projection, width: windowBox.width, height: windowBox.height };
    }
    if (!projection) stop(true);
  }, [projection, windowBox.width, windowBox.height, stop]);
  useEffect(() => {
    if (!visible || !projection) return;
    const node = ref.current;
    const wheel = (event: WheelEvent) => event.preventDefault();
    node?.addEventListener("wheel", wheel, { passive: false });
    return () => node?.removeEventListener("wheel", wheel);
  }, [visible, projection]);
  const pointOf = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return projection
      ? minimapWorldPoint({ x: event.clientX - box.left, y: event.clientY - box.top }, projection)
      : { x: 0, y: 0 };
  };
  const finish = (event: PointerEvent<SVGSVGElement>, cancelMotion: boolean) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    stop(cancelMotion);
    event.currentTarget.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true });
  };
  return {
    ref,
    onPointerDown: (event: PointerEvent<SVGSVGElement>) => {
      if (event.button !== 0 || !event.isPrimary || drag.current || !projection) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
      const point = pointOf(event);
      const onIndicator =
        event.target instanceof Element && event.target.hasAttribute("data-minimap-viewport");
      const offset = onIndicator ? { x: point.x - windowBox.x, y: point.y - windowBox.y } : null;
      drag.current = { pointerId: event.pointerId, offset };
      event.currentTarget.setPointerCapture(event.pointerId);
      if (!offset)
        motion.current = navigate(
          { x: point.x - windowBox.width / 2, y: point.y - windowBox.height / 2 },
          true,
        );
    },
    onPointerMove: (event: PointerEvent<SVGSVGElement>) => {
      const active = drag.current;
      if (!active?.offset || active.pointerId !== event.pointerId) return;
      const point = pointOf(event);
      navigate({ x: point.x - active.offset.x, y: point.y - active.offset.y }, false);
    },
    onPointerUp: (event: PointerEvent<SVGSVGElement>) => finish(event, false),
    onPointerCancel: (event: PointerEvent<SVGSVGElement>) => finish(event, true),
    onLostPointerCapture: (event: PointerEvent<SVGSVGElement>) => finish(event, true),
  };
}
