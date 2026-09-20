/** @vitest-environment happy-dom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../../src/App.tsx";
import { ConnectedGroups } from "../../src/overview/ConnectedGroups.tsx";
import { installBridge } from "./support.ts";

let viewportWidth = 1200;
let viewportHeight = 800;
const resizeCallbacks = new Set<() => void>();
beforeEach(() => {
  viewportWidth = 1200;
  viewportHeight = 800;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("connected-groups") ? viewportWidth : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("connected-groups") ? viewportHeight : 0;
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {}
      observe() {
        resizeCallbacks.add(this.callback);
      }
      disconnect() {
        resizeCallbacks.delete(this.callback);
      }
      unobserve() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resizeCallbacks.clear();
});
async function open() {
  const log = installBridge();
  const bridge = window.symmetriaFm;
  if (!bridge) throw new Error("missing bridge");
  const overviewReads = vi.spyOn(bridge, "overview");
  render(<App startPath="/home/jc" />);
  fireEvent.keyDown(window, { key: "o", ctrlKey: true });
  await screen.findByTestId("connected-groups");
  await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
  return { ...log, overviewReads };
}
const map = () => screen.getByRole("img", { name: "Folder overview minimap" });
const leaf = (name: string) => ({
  name,
  kind: "directory" as const,
  isHidden: false,
  isSymlink: false,
});
function model() {
  return {
    folders: new Map([
      ["/root", { path: "/root", depth: 0, status: "Loaded", entries: [leaf("a")] }],
      ["/root/a", { path: "/root/a", depth: 1, status: "Loaded", entries: [leaf("b")] }],
      ["/root/a/b", { path: "/root/a/b", depth: 2, status: "Loaded", entries: [] }],
    ]),
    inspected: 2,
    loading: false,
    include: () => undefined,
  };
}
it("toggles through Alt+M and includes the binding in keyboard help", async () => {
  await open();
  expect(map()).toBeTruthy();
  fireEvent.keyDown(window, { key: "m", altKey: true });
  expect(screen.queryByRole("img", { name: "Folder overview minimap" })).toBeNull();
  fireEvent.keyDown(window, { key: "m", altKey: true });
  expect(map()).toBeTruthy();
  fireEvent.keyDown(window, { key: "?", shiftKey: true });
  expect(await screen.findByText("Toggle minimap")).toBeTruthy();
});
it("remembers visibility through close, reopen, and a focused root", async () => {
  await open();
  expect(map()).toBeTruthy();
  fireEvent.keyDown(window, { key: "m", altKey: true });
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.keyDown(window, { key: "o", ctrlKey: true });
  await screen.findByTestId("connected-groups");
  expect(screen.queryByRole("img", { name: "Folder overview minimap" })).toBeNull();
  fireEvent.keyDown(window, { key: "l" });
  screen.getByText("Details").closest("details")?.setAttribute("open", "");
  fireEvent.click(screen.getByRole("button", { name: "Focus here" }));
  expect(screen.queryByRole("img", { name: "Folder overview minimap" })).toBeNull();
});
it("maps offscreen groups but omits descendants of collapsed groups", () => {
  render(<ConnectedGroups root="/root" model={model()} />);
  const viewport = screen.getByTestId("connected-groups");
  viewport.scrollLeft = 10000;
  fireEvent.scroll(viewport);
  expect(map().querySelectorAll("[data-minimap-group]")).toHaveLength(3);
  expect(viewport.querySelectorAll("[data-group]").length).toBeLessThan(3);
  viewport.scrollLeft = 0;
  fireEvent.scroll(viewport);
  fireEvent.click(screen.getByRole("button", { name: "Collapse a" }));
  expect(map().querySelectorAll("[data-minimap-group]")).toHaveLength(2);
});
it("updates the viewport indicator when actual scroll or zoom changes", () => {
  render(<ConnectedGroups root="/root" model={model()} />);
  const viewport = screen.getByTestId("connected-groups");
  const indicator = () => map().querySelector("[data-minimap-viewport]");
  const initial = indicator()?.getAttribute("x");
  viewport.scrollLeft = 500;
  fireEvent.scroll(viewport);
  expect(indicator()?.getAttribute("x")).not.toBe(initial);
  const before = indicator()?.getAttribute("width");
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(indicator()?.getAttribute("width")).not.toBe(before);
});
it("places the map outside the scrolling and scaled graph", () => {
  render(<ConnectedGroups root="/root" model={model()} />);
  const viewport = screen.getByTestId("connected-groups");
  expect(viewport.contains(map())).toBe(false);
  expect(map().closest(".overview-canvas")).toBeNull();
  expect(viewport.parentElement?.contains(map())).toBe(true);
});
it("does not add reads, watches, or full cards when toggled", async () => {
  const log = await open();
  const viewport = screen.getByTestId("connected-groups");
  const before = {
    overviewReads: log.overviewReads.mock.calls.length,
    reads: log.listed.length,
    watches: log.watched.length,
    cards: viewport.querySelectorAll("[data-group]").length,
  };
  expect(map().querySelectorAll("[data-minimap-group]").length).toBeGreaterThan(0);
  fireEvent.keyDown(window, { key: "m", altKey: true });
  fireEvent.keyDown(window, { key: "m", altKey: true });
  expect({
    overviewReads: log.overviewReads.mock.calls.length,
    reads: log.listed.length,
    watches: log.watched.length,
    cards: viewport.querySelectorAll("[data-group]").length,
  }).toEqual(before);
});
it("exposes visibility state without making graph primitives focusable", async () => {
  await open();
  const toggle = screen.getByRole("button", { name: "Toggle minimap" });
  expect(toggle.closest("details")).toBeNull();
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  expect(map().querySelectorAll("button,[tabindex]")).toHaveLength(0);
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
});

it("withholds a minimap after its measured viewport becomes zero-sized", () => {
  render(<ConnectedGroups root="/root" model={model()} />);
  expect(map()).toBeTruthy();
  viewportWidth = 0;
  act(() => {
    for (const callback of resizeCallbacks) callback();
  });
  expect(screen.queryByRole("img", { name: "Folder overview minimap" })).toBeNull();
});

function assertProjection() {
  const viewport = screen.getByTestId("connected-groups");
  const canvas = viewport.querySelector<HTMLElement>(".overview-canvas");
  if (!canvas) throw new Error("missing canvas");
  const match = /translate\(([-.\d]+)px, ([-.\d]+)px\)/.exec(canvas.style.transform);
  if (!match) throw new Error("missing origin");
  const zoom = Number(viewport.dataset.zoom);
  const graphWidth = Number.parseFloat(canvas.style.width);
  const graphHeight = Number.parseFloat(canvas.style.height);
  const width = Number(map().getAttribute("width"));
  const height = Number(map().getAttribute("height"));
  const scale = Math.min((width - 16) / graphWidth, (height - 16) / graphHeight);
  const offsetX = (width - graphWidth * scale) / 2;
  const offsetY = (height - graphHeight * scale) / 2;
  const x = (viewport.scrollLeft - Number(match[1])) / zoom;
  const y = (viewport.scrollTop - Number(match[2])) / zoom;
  const left = Math.max(0, Math.min(graphWidth, x));
  const top = Math.max(0, Math.min(graphHeight, y));
  const right = Math.max(0, Math.min(graphWidth, x + viewportWidth / zoom));
  const bottom = Math.max(0, Math.min(graphHeight, y + viewportHeight / zoom));
  const indicator = map().querySelector("[data-minimap-viewport]");
  for (const [attribute, value] of Object.entries({
    x: offsetX + left * scale,
    y: offsetY + top * scale,
    width: (right - left) * scale,
    height: (bottom - top) * scale,
  })) {
    expect(Number(indicator?.getAttribute(attribute))).toBeCloseTo(value, 8);
  }
}
it("projects restored origin, live layout, zoom, fit, and measured resize accurately", () => {
  const initial = {
    ...model(),
    view: {
      selected: "/root",
      collapsed: new Set<string>(),
      zoom: 0.5,
      origin: { x: 37, y: 29 },
      scroll: { x: 120, y: 70 },
      boxes: new Map(),
    },
  };
  const { rerender } = render(<ConnectedGroups root="/root" model={initial} />);
  assertProjection();
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  fireEvent.scroll(screen.getByTestId("connected-groups"));
  assertProjection();
  fireEvent.click(screen.getByRole("button", { name: "Fit" }));
  fireEvent.scroll(screen.getByTestId("connected-groups"));
  assertProjection();
  viewportWidth = 640;
  viewportHeight = 480;
  act(() => {
    for (const callback of resizeCallbacks) callback();
  });
  assertProjection();
  const changed = model();
  changed.folders.set("/root/a/b", {
    path: "/root/a/b",
    depth: 2,
    status: "Loaded",
    entries: Array.from({ length: 120 }, (_, i) => leaf(String(i))),
  });
  rerender(<ConnectedGroups root="/root" model={changed} />);
  fireEvent.scroll(screen.getByTestId("connected-groups"));
  assertProjection();
});
it("tracks the actual camera after keyboard pan", async () => {
  await open();
  vi.useFakeTimers();
  fireEvent.keyDown(window, { key: "l", ctrlKey: true });
  act(() => vi.advanceTimersByTime(200));
  fireEvent.scroll(screen.getByTestId("connected-groups"));
  assertProjection();
});

function interactiveGraph() {
  viewportWidth = 800;
  viewportHeight = 600;
  const snapshot = model();
  const names = Array.from({ length: 60 }, (_, i) => `folder${i}`);
  snapshot.folders.set("/root", {
    path: "/root",
    depth: 0,
    status: "Loaded",
    entries: names.map(leaf),
  });
  for (const name of names)
    snapshot.folders.set(`/root/${name}`, {
      path: `/root/${name}`,
      depth: 1,
      status: "Loaded",
      entries: [],
    });
  const view = render(
    <div role="dialog" tabIndex={-1}>
      <ConnectedGroups root="/root" model={snapshot} />
    </div>,
  );
  const svg = map();
  svg.getBoundingClientRect = () =>
    new DOMRect(10, 20, Number(svg.getAttribute("width")), Number(svg.getAttribute("height")));
  const captured = new Set<number>();
  Object.assign(svg, {
    setPointerCapture: (id: number) => captured.add(id),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => captured.delete(id),
  });
  return { ...view, svg, viewport: screen.getByTestId("connected-groups"), snapshot, captured };
}
const primary = { button: 0, pointerId: 7, isPrimary: true };
function mapPoint(svg: HTMLElement, fraction: number) {
  return {
    clientX: 10 + Number(svg.getAttribute("width")) / 2,
    clientY: 20 + Number(svg.getAttribute("height")) * fraction,
  };
}
it("recenters from a minimap press without changing selection or zoom", () => {
  vi.useFakeTimers();
  const { svg, viewport } = interactiveGraph();
  const selected = viewport.dataset.selected;
  fireEvent.pointerDown(svg, { ...primary, ...mapPoint(svg, 0.75) });
  act(() => vi.advanceTimersByTime(200));
  expect(viewport.scrollTop).toBeGreaterThan(1000);
  expect(viewport.dataset.selected).toBe(selected);
  expect(viewport.dataset.zoom).toBe("1");
});
it("drags the viewport rectangle immediately without a grab jump", () => {
  const { svg, viewport, captured } = interactiveGraph();
  const indicator = svg.querySelector("[data-minimap-viewport]");
  if (!indicator) throw new Error("missing indicator");
  const clientX = 10 + Number(indicator.getAttribute("x")) + 2;
  const clientY = 20 + Number(indicator.getAttribute("y")) + 2;
  fireEvent.pointerDown(indicator, { ...primary, clientX, clientY });
  expect(captured.has(7)).toBe(true);
  expect(viewport.scrollTop).toBe(0);
  fireEvent.pointerMove(svg, { ...primary, clientX, clientY: clientY + 20 });
  expect(viewport.scrollTop).toBeGreaterThan(500);
  const canvas = viewport.querySelector<HTMLElement>(".overview-canvas");
  if (!canvas) throw new Error("missing canvas");
  const scale = (Number(svg.getAttribute("height")) - 16) / Number.parseFloat(canvas.style.height);
  expect(viewport.scrollTop).toBeCloseTo(20 / scale, 8);
});
it.each(["pointerCancel", "lostPointerCapture"] as const)(
  "stops minimap movement after %s",
  (eventName) => {
    const { svg, viewport } = interactiveGraph();
    const indicator = svg.querySelector("[data-minimap-viewport]");
    if (!indicator) throw new Error("missing indicator");
    const point = {
      clientX: 10 + Number(indicator.getAttribute("x")) + 2,
      clientY: 20 + Number(indicator.getAttribute("y")) + 2,
    };
    fireEvent.pointerDown(indicator, { ...primary, ...point });
    fireEvent.pointerMove(svg, { ...primary, ...point, clientY: point.clientY + 20 });
    expect(viewport.scrollTop).toBeGreaterThan(0);
    fireEvent[eventName](svg, primary);
    const stopped = viewport.scrollTop;
    fireEvent.pointerMove(svg, { ...primary, ...point, clientY: point.clientY + 40 });
    expect(viewport.scrollTop).toBe(stopped);
  },
);
it("returns focus to the dialog and blocks wheel input over the map", () => {
  vi.useFakeTimers();
  const { svg } = interactiveGraph();
  fireEvent.pointerDown(svg, { ...primary, ...mapPoint(svg, 0.75) });
  fireEvent.pointerUp(svg, primary);
  expect(document.activeElement).toBe(screen.getByRole("dialog"));
  expect(fireEvent.wheel(svg, { deltaY: 100, cancelable: true })).toBe(false);
});
it("cancels active minimap navigation when hidden or resized", () => {
  vi.useFakeTimers();
  const { svg, viewport, rerender, snapshot } = interactiveGraph();
  fireEvent.pointerDown(svg, { ...primary, ...mapPoint(svg, 0.75) });
  act(() => vi.advanceTimersByTime(40));
  expect(viewport.scrollTop).toBeGreaterThan(0);
  rerender(
    <div role="dialog" tabIndex={-1}>
      <ConnectedGroups root="/root" model={snapshot} minimapVisible={false} />
    </div>,
  );
  const stopped = viewport.scrollTop;
  act(() => vi.advanceTimersByTime(200));
  expect(viewport.scrollTop).toBe(stopped);
});
it.each([640, 800, 1440])("keeps navigation aligned at viewport width %s", (width) => {
  vi.useFakeTimers();
  const { svg, viewport } = interactiveGraph();
  viewportWidth = width;
  act(() => {
    for (const callback of resizeCallbacks) callback();
  });
  fireEvent.pointerDown(svg, { ...primary, ...mapPoint(svg, 0.75) });
  act(() => vi.advanceTimersByTime(200));
  expect(viewport.scrollTop).toBeGreaterThan(1000);
  fireEvent.scroll(viewport);
  assertProjection();
});
it("pans the minimap without requesting more filesystem data", async () => {
  const log = await open();
  const svg = map();
  const before = log.overviewReads.mock.calls.length;
  svg.getBoundingClientRect = () =>
    new DOMRect(10, 20, Number(svg.getAttribute("width")), Number(svg.getAttribute("height")));
  Object.assign(svg, {
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => false,
    releasePointerCapture: vi.fn(),
  });
  vi.useFakeTimers();
  const viewport = screen.getByTestId("connected-groups");
  const old = viewport.scrollLeft;
  fireEvent.pointerDown(svg, {
    ...primary,
    clientX: 10 + Number(svg.getAttribute("width")) - 10,
    clientY: 50,
  });
  act(() => vi.advanceTimersByTime(200));
  expect(viewport.scrollLeft).not.toBe(old);
  expect(log.overviewReads.mock.calls.length).toBe(before);
});

it("keeps dragging when refreshed group objects retain the same geometry", () => {
  const { svg, viewport, rerender, snapshot, captured } = interactiveGraph();
  const indicator = svg.querySelector("[data-minimap-viewport]");
  if (!indicator) throw new Error("missing indicator");
  const point = {
    clientX: 10 + Number(indicator.getAttribute("x")) + 2,
    clientY: 20 + Number(indicator.getAttribute("y")) + 2,
  };
  fireEvent.pointerDown(indicator, { ...primary, ...point });
  fireEvent.pointerMove(svg, { ...primary, ...point, clientY: point.clientY + 10 });
  const before = viewport.scrollTop;
  rerender(
    <div role="dialog" tabIndex={-1}>
      <ConnectedGroups root="/root" model={{ ...snapshot, folders: new Map(snapshot.folders) }} />
    </div>,
  );
  expect(captured.has(7)).toBe(true);
  fireEvent.pointerMove(svg, { ...primary, ...point, clientY: point.clientY + 30 });
  expect(viewport.scrollTop).toBeGreaterThan(before);
});
it("finishes a recenter animation when newly measured graph bounds change", () => {
  vi.useFakeTimers();
  const { svg, viewport, rerender, snapshot } = interactiveGraph();
  fireEvent.pointerDown(svg, { ...primary, ...mapPoint(svg, 0.75) });
  fireEvent.pointerUp(svg, primary);
  act(() => vi.advanceTimersByTime(40));
  const before = viewport.scrollTop;
  const changed = { ...snapshot, folders: new Map(snapshot.folders) };
  changed.folders.set("/root/new", { path: "/root/new", depth: 1, status: "Loaded", entries: [] });
  rerender(
    <div role="dialog" tabIndex={-1}>
      <ConnectedGroups root="/root" model={changed} />
    </div>,
  );
  act(() => vi.advanceTimersByTime(200));
  expect(viewport.scrollTop).toBeGreaterThan(before);
});
