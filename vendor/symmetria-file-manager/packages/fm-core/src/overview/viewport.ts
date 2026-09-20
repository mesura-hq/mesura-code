import type { Box } from "./layout.ts";
import type { Direction } from "./navigation.ts";
export interface Point {
  readonly x: number;
  readonly y: number;
}
export interface Size {
  readonly width: number;
  readonly height: number;
}
export function panTarget(
  current: Point,
  viewport: Size,
  direction: Direction,
  fraction: number,
  bounds: Size,
): Point {
  const dx = direction === "left" ? -viewport.width : direction === "right" ? viewport.width : 0;
  const dy = direction === "up" ? -viewport.height : direction === "down" ? viewport.height : 0;
  return clampScroll(
    { x: current.x + dx * fraction, y: current.y + dy * fraction },
    viewport,
    bounds,
  );
}
export function zoomScroll(scroll: Point, anchor: Point, from: number, to: number): Point {
  return {
    x: ((scroll.x + anchor.x) * to) / from - anchor.x,
    y: ((scroll.y + anchor.y) * to) / from - anchor.y,
  };
}

export interface MinimapProjection extends Size {
  readonly scale: number;
  readonly offset: Point;
  readonly graph: Size;
}
export function minimapProjection(graph: Size, viewport: Size): MinimapProjection | null {
  const maxWidth = Math.min(viewport.width / 4, viewport.width - 32);
  const maxHeight = Math.min(viewport.height * 0.3, viewport.height - 32);
  const padding = 16;
  if (maxWidth <= padding || maxHeight <= padding) return null;
  const safeGraph = { width: Math.max(1, graph.width), height: Math.max(1, graph.height) };
  const scale = Math.min(
    (maxWidth - padding) / safeGraph.width,
    (maxHeight - padding) / safeGraph.height,
  );
  // Fit both surface dimensions to the graph; retain a usable pointer target for thin graphs.
  const width = Math.max(Math.min(80, maxWidth), safeGraph.width * scale + padding);
  const height = Math.max(Math.min(80, maxHeight), safeGraph.height * scale + padding);
  return {
    width,
    height,
    scale,
    graph: safeGraph,
    offset: {
      x: (width - safeGraph.width * scale) / 2,
      y: (height - safeGraph.height * scale) / 2,
    },
  };
}
export function projectMinimapViewport(
  viewport: Box,
  projection: MinimapProjection,
): Box & { outside: boolean } {
  const { graph, scale, offset } = projection;
  const left = Math.max(0, Math.min(graph.width, viewport.x));
  const top = Math.max(0, Math.min(graph.height, viewport.y));
  const right = Math.max(0, Math.min(graph.width, viewport.x + viewport.width));
  const bottom = Math.max(0, Math.min(graph.height, viewport.y + viewport.height));
  return {
    x: offset.x + left * scale,
    y: offset.y + top * scale,
    width: (right - left) * scale,
    height: (bottom - top) * scale,
    outside: right <= left || bottom <= top,
  };
}

export function clampScroll(point: Point, viewport: Size, bounds: Size): Point {
  return {
    x: Math.max(0, Math.min(Math.max(0, bounds.width - viewport.width), point.x)),
    y: Math.max(0, Math.min(Math.max(0, bounds.height - viewport.height), point.y)),
  };
}
export function minimapWorldPoint(point: Point, projection: MinimapProjection): Point {
  return {
    x: (point.x - projection.offset.x) / projection.scale,
    y: (point.y - projection.offset.y) / projection.scale,
  };
}
