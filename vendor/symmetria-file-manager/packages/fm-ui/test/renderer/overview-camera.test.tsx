/** @vitest-environment happy-dom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useGraphCamera } from "../../src/overview/useGraphCamera.ts";
import { useCameraAnimation } from "../../src/overview/useOverviewCamera.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("retargets held-key animation and uses immediate reduced motion", () => {
  vi.useFakeTimers();
  let point = { x: 0, y: 0 };
  const write = (value: typeof point) => {
    point = value;
  };
  const { result } = renderHook(() => useCameraAnimation(() => point, write, false));
  act(() => result.current({ x: 100, y: 0 }));
  act(() => vi.advanceTimersByTime(50));
  act(() => result.current({ x: 200, y: 0 }));
  act(() => vi.advanceTimersByTime(200));
  expect(point.x).toBe(200);
  const reduced = renderHook(() => useCameraAnimation(() => point, write, true));
  act(() => reduced.result.current({ x: 50, y: 10 }));
  expect(point).toEqual({ x: 50, y: 10 });
});

it.each([40, -20])(
  "retains a visible root header anchor at the scroll origin (left=%s)",
  (headerLeft) => {
    const viewport = document.createElement("div");
    const extent = document.createElement("div");
    const group = document.createElement("section");
    const header = document.createElement("button");
    group.dataset.group = "/root";
    header.setAttribute("data-basename", "");
    group.append(header);
    viewport.append(group);
    Object.defineProperties(viewport, {
      clientWidth: { value: 800 },
      clientHeight: { value: 600 },
    });
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    group.getBoundingClientRect = () => new DOMRect(0, 0, 240, 500);
    header.getBoundingClientRect = () => new DOMRect(headerLeft, 20, 120, 20);
    let left = 0;
    Object.defineProperty(viewport, "scrollLeft", {
      get: () => left,
      set: (value: number) => {
        left = Math.max(0, value);
      },
    });
    const { result } = renderHook(() => {
      const [zoom, setZoom] = useState(1);
      const [origin, setOrigin] = useState({ x: 0, y: 0 });
      const camera = useGraphCamera({
        viewport: { current: viewport },
        extent: { current: extent },
        selected: "/root",
        zoom,
        setZoom,
        origin,
        setOrigin,
        bounds: { width: 2000, height: 1000 },
      });
      return { camera, zoom, origin };
    });
    act(() => result.current.camera.changeZoom(0.5));
    const center = headerLeft + 60;
    expect(result.current.origin).toEqual({ x: center / 2, y: 15 });
    expect(center * result.current.zoom + result.current.origin.x - viewport.scrollLeft).toBe(
      center,
    );
    expect(30 * result.current.zoom + result.current.origin.y - viewport.scrollTop).toBe(30);
  },
);
it("clamps keyboard pan to geometry with screen padding despite a larger browser extent", () => {
  vi.useFakeTimers();
  const viewport = document.createElement("div");
  Object.defineProperties(viewport, {
    clientWidth: { value: 800 },
    clientHeight: { value: 600 },
    scrollWidth: { value: 5000 },
    scrollHeight: { value: 5000 },
  });
  const { result } = renderHook(() =>
    useGraphCamera({
      viewport: { current: viewport },
      extent: { current: null },
      selected: "/root",
      zoom: 0.5,
      setZoom: () => undefined,
      origin: { x: 0, y: 0 },
      setOrigin: () => undefined,
      bounds: { width: 2000, height: 1000 },
    }),
  );
  act(() => result.current.pan("right", 1));
  act(() => vi.advanceTimersByTime(200));
  expect(viewport.scrollLeft).toBe(212);
  act(() => result.current.pan("down", 1));
  act(() => vi.advanceTimersByTime(200));
  expect(viewport.scrollTop).toBe(0);
});

it.each([0.1, 1, 2])(
  "clamps minimap targets like keyboard pan at zoom %s and nonzero origin",
  (zoom) => {
    vi.useFakeTimers();
    const viewport = document.createElement("div");
    Object.defineProperties(viewport, {
      clientWidth: { value: 800 },
      clientHeight: { value: 600 },
    });
    const { result } = renderHook(() =>
      useGraphCamera({
        viewport: { current: viewport },
        extent: { current: null },
        selected: "/root",
        zoom,
        setZoom: () => undefined,
        origin: { x: 37, y: 29 },
        setOrigin: () => undefined,
        bounds: { width: 10000, height: 12000 },
      }),
    );
    act(() => result.current.moveTo({ x: 1e6, y: 1e6 }, false));
    expect(viewport.scrollLeft).toBeCloseTo((10000 - 24) * zoom + 37 + 24 - 800);
    expect(viewport.scrollTop).toBeCloseTo((12000 - 24) * zoom + 29 + 24 - 600);
    act(() => result.current.moveTo({ x: -1e6, y: -1e6 }, false));
    expect(viewport.scrollLeft).toBe(0);
    expect(viewport.scrollTop).toBe(0);
  },
);
it("replaces pending animation with an immediate minimap camera target", () => {
  vi.useFakeTimers();
  const viewport = document.createElement("div");
  Object.defineProperties(viewport, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
  const { result } = renderHook(() =>
    useGraphCamera({
      viewport: { current: viewport },
      extent: { current: null },
      selected: "/root",
      zoom: 1,
      setZoom: () => undefined,
      origin: { x: 0, y: 0 },
      setOrigin: () => undefined,
      bounds: { width: 10000, height: 12000 },
    }),
  );
  act(() => result.current.pan("down", 1));
  act(() => vi.advanceTimersByTime(30));
  act(() => result.current.moveTo({ x: 300, y: 400 }, false));
  expect(viewport.scrollTop).toBe(400);
  act(() => vi.advanceTimersByTime(200));
  expect(viewport.scrollTop).toBe(400);
});

it("does not let stale minimap cleanup cancel a newer keyboard target", () => {
  vi.useFakeTimers();
  const viewport = document.createElement("div");
  Object.defineProperties(viewport, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
  const { result } = renderHook(() =>
    useGraphCamera({
      viewport: { current: viewport },
      extent: { current: null },
      selected: "/root",
      zoom: 1,
      setZoom: () => undefined,
      origin: { x: 0, y: 0 },
      setOrigin: () => undefined,
      bounds: { width: 10000, height: 12000 },
    }),
  );
  let cancelMap: (() => void) | undefined;
  act(() => {
    cancelMap = result.current.moveTo({ x: 0, y: 2000 }, true);
  });
  act(() => result.current.pan("down", 1));
  act(() => cancelMap?.());
  act(() => vi.advanceTimersByTime(200));
  expect(viewport.scrollTop).toBe(2600);
});
it("re-clamps a pending map target when graph bounds grow", () => {
  vi.useFakeTimers();
  const viewport = document.createElement("div");
  Object.defineProperties(viewport, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
  const { result, rerender } = renderHook(
    ({ height }) =>
      useGraphCamera({
        viewport: { current: viewport },
        extent: { current: null },
        selected: "/root",
        zoom: 1,
        setZoom: () => undefined,
        origin: { x: 0, y: 0 },
        setOrigin: () => undefined,
        bounds: { width: 10000, height },
      }),
    { initialProps: { height: 1000 } },
  );
  act(() => result.current.moveTo({ x: 0, y: 2000 }, true));
  act(() => vi.advanceTimersByTime(30));
  rerender({ height: 3000 });
  act(() => vi.advanceTimersByTime(200));
  expect(viewport.scrollTop).toBe(2000);
});

it("clamps restored search offsets when the graph shrinks", () => {
  const viewport = document.createElement("div");
  Object.defineProperties(viewport, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
  const { result } = renderHook(() =>
    useGraphCamera({
      viewport: { current: viewport },
      extent: { current: null },
      selected: "/root",
      zoom: 1,
      setZoom: () => undefined,
      origin: { x: 0, y: 0 },
      setOrigin: () => undefined,
      bounds: { width: 900, height: 650 },
    }),
  );
  act(() => result.current.restore({ x: 200, y: 300 }));
  expect([viewport.scrollLeft, viewport.scrollTop]).toEqual([100, 50]);
});
