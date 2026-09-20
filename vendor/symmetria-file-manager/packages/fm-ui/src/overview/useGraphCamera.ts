import type { Direction } from "@symmetria/fm-core/overview/navigation";
import type { Size } from "@symmetria/fm-core/overview/viewport";
import {
  clampScroll,
  type Point,
  panTarget,
  zoomScroll,
} from "@symmetria/fm-core/overview/viewport";
import type { RefObject } from "react";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
export interface GraphCameraOptions {
  viewport: RefObject<HTMLDivElement | null>;
  extent: RefObject<HTMLDivElement | null>;
  selected: string;
  zoom: number;
  setZoom: (zoom: number) => void;
  origin: Point;
  setOrigin: (origin: Point) => void;
  bounds: Size;
}

import { useCameraAnimation } from "./useOverviewCamera.ts";

export function selectedElement(node: HTMLElement, selected: string): HTMLElement | undefined {
  const rows = [...node.querySelectorAll<HTMLElement>("[data-entry]")].filter(
    (element) => element.dataset.entry === selected,
  );
  const header = [...node.querySelectorAll<HTMLElement>("[data-group]")]
    .find((element) => element.dataset.group === selected)
    ?.querySelector<HTMLElement>("[data-basename]");
  const candidates = header ? [...rows, header] : rows;
  const viewport = node.getBoundingClientRect();
  return (
    candidates.find((element) => {
      const box = element.getBoundingClientRect();
      return (
        box.width > 0 &&
        box.height > 0 &&
        box.right > viewport.left &&
        box.left < viewport.right &&
        box.bottom > viewport.top &&
        box.top < viewport.bottom
      );
    }) ?? candidates[0]
  );
}
export function useGraphCamera(options: GraphCameraOptions) {
  const { viewport, extent, selected, zoom, setZoom, origin, setOrigin, bounds } = options;
  const pending = useRef<Point | null>(null);
  const minimapTarget = useRef<{ point: Point } | null>(null);
  const read = () => ({
    x: viewport.current?.scrollLeft ?? 0,
    y: viewport.current?.scrollTop ?? 0,
  });
  const write = useCallback(
    (point: Point) => {
      const node = viewport.current;
      if (node) {
        node.scrollLeft = point.x;
        node.scrollTop = point.y;
      }
      if (pending.current?.x === point.x && pending.current.y === point.y) {
        pending.current = null;
        minimapTarget.current = null;
      }
    },
    [viewport],
  );
  const animate = useCameraAnimation(read, write);
  const cancel = useCallback(() => {
    animate.cancel();
    pending.current = null;
    minimapTarget.current = null;
  }, [animate]);
  const zoomTarget = useRef<{ point: Point; zoom: number; origin: Point } | null>(null);
  const changeZoom = (next: number) => {
    cancel();
    const node = viewport.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    const chosen = selectedElement(node, selected)?.getBoundingClientRect();
    let anchor = { x: node.clientWidth / 2, y: node.clientHeight / 2 };
    if (
      chosen &&
      chosen.right > box.left &&
      chosen.left < box.right &&
      chosen.bottom > box.top &&
      chosen.top < box.bottom
    )
      anchor = {
        x: (chosen.left + chosen.right) / 2 - box.left,
        y: (chosen.top + chosen.bottom) / 2 - box.top,
      };
    const target = Math.max(0.1, Math.min(2, next));
    const current = read();
    const relative = zoomScroll(
      { x: current.x - origin.x, y: current.y - origin.y },
      anchor,
      zoom,
      target,
    );
    const desired = { x: relative.x + origin.x, y: relative.y + origin.y };
    // Native scroll cannot be negative. Leading canvas space retains the
    // selected header anchor when zooming out at the origin.
    const nextOrigin = {
      x: origin.x + Math.max(0, -desired.x),
      y: origin.y + Math.max(0, -desired.y),
    };
    zoomTarget.current = {
      point: { x: Math.max(0, desired.x), y: Math.max(0, desired.y) },
      zoom: target,
      origin: nextOrigin,
    };
    setOrigin(nextOrigin);
    setZoom(target);
  };
  useLayoutEffect(() => {
    const target = zoomTarget.current;
    const node = viewport.current;
    if (!target || target.zoom !== zoom || target.origin !== origin || !node) return;
    if (extent.current) {
      extent.current.style.minWidth = `${target.point.x + node.clientWidth}px`;
      extent.current.style.minHeight = `${target.point.y + node.clientHeight}px`;
    }
    write(target.point);
    zoomTarget.current = null;
  }, [zoom, origin, viewport, extent, write]);
  const scrollBounds = useMemo(
    () => ({
      width: (bounds.width - 24) * zoom + origin.x + 24,
      height: (bounds.height - 24) * zoom + origin.y + 24,
    }),
    [bounds, zoom, origin],
  );
  const moveTo = (point: Point, animated: boolean) => {
    cancel();
    const node = viewport.current;
    if (!node) return;
    const intent = { point };
    const target = minimapScroll(point, zoom, origin, node, scrollBounds);
    if (animated) {
      minimapTarget.current = intent;
      pending.current = target;
      animate(target);
    } else write(target);
    return () => {
      if (minimapTarget.current === intent) cancel();
    };
  };
  useLayoutEffect(() => {
    const node = viewport.current;
    const intent = minimapTarget.current;
    if (!node || !intent) return;
    const target = minimapScroll(intent.point, zoom, origin, node, scrollBounds);
    if (target.x === pending.current?.x && target.y === pending.current.y) return;
    // Re-clamp a pending edge click when newly mounted cards change graph bounds.
    pending.current = target;
    animate(target);
  }, [viewport, zoom, origin, scrollBounds, animate]);

  const pan = (direction: Direction, fraction: number) => {
    const node = viewport.current;
    if (!node) return;
    minimapTarget.current = null;
    const target = panTarget(
      pending.current ?? read(),
      { width: node.clientWidth, height: node.clientHeight },
      direction,
      fraction,
      scrollBounds,
    );
    pending.current = target;
    animate(target);
  };
  const fit = () => {
    cancel();
    const node = viewport.current;
    if (!node) return;
    const target = Math.max(
      0.1,
      Math.min(
        2,
        (node.clientWidth - 48) / Math.max(1, bounds.width - 48),
        (node.clientHeight - 48) / Math.max(1, bounds.height - 48),
      ),
    );
    setZoom(target);
    setOrigin({ x: 24 - 24 * target, y: 24 - 24 * target });
    zoomTarget.current = null;
    if (extent.current) {
      extent.current.style.minWidth = "0px";
      extent.current.style.minHeight = "0px";
    }
    write({ x: 0, y: 0 });
  };
  const restore = (point: Point) => {
    cancel();
    const node = viewport.current;
    if (node)
      write(
        clampScroll(point, { width: node.clientWidth, height: node.clientHeight }, scrollBounds),
      );
  };
  return { cancel, changeZoom, pan, fit, moveTo, restore };
}

function minimapScroll(
  point: Point,
  zoom: number,
  origin: Point,
  node: HTMLDivElement,
  bounds: Size,
): Point {
  return clampScroll(
    { x: point.x * zoom + origin.x, y: point.y * zoom + origin.y },
    { width: node.clientWidth, height: node.clientHeight },
    bounds,
  );
}
