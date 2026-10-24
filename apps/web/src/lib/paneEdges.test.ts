// @vitest-environment happy-dom
// Entry points: `movePaneEdgeBorder` and `usePaneEdge` (`paneEdges.ts`). The
// edges mount through `usePaneEdge` on a separator element, as the sidebar
// rail, the right panel handle and the terminal drawer edge do, and the arrow
// keys reach it as a focused separator receives them.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  borderMoveDelta,
  getPaneEdge,
  movePaneEdgeBorder,
  paneEdgeStep,
  usePaneEdge,
  type PaneEdge,
  type PaneEdgeId,
  type PaneEdgeSide,
} from "./paneEdges";
import { resizeEdgeFor } from "../keys/paneMode";

describe("paneEdgeStep", () => {
  it("is 5% of the viewport along the edge's axis", () => {
    const viewport = { width: 1920, height: 1080 };
    expect(paneEdgeStep("left", viewport)).toBe(96);
    expect(paneEdgeStep("right", viewport)).toBe(96);
    expect(paneEdgeStep("top", viewport)).toBe(54);
  });
});

describe("borderMoveDelta (arrow keys on a focused separator)", () => {
  it("moves the border with the arrow, whichever side of its panel it is on", () => {
    // The sidebar's border is on its right: moving it right widens the sidebar.
    expect(borderMoveDelta("right", "right", 10)).toBe(10);
    expect(borderMoveDelta("right", "left", 10)).toBe(-10);
    // The right panel's border is on its left: moving it right narrows the panel.
    expect(borderMoveDelta("left", "right", 10)).toBe(-10);
    expect(borderMoveDelta("left", "left", 10)).toBe(10);
    // The terminal drawer's border is on its top: moving it up makes it taller.
    expect(borderMoveDelta("top", "up", 10)).toBe(10);
    expect(borderMoveDelta("top", "down", 10)).toBe(-10);
  });

  it("ignores the arrows across the edge's axis", () => {
    expect(borderMoveDelta("left", "up", 10)).toBeNull();
    expect(borderMoveDelta("top", "left", 10)).toBeNull();
  });
});

describe("resizeEdgeFor (PANE mode: the focused pane picks the border, the key moves it)", () => {
  it("moves each side pane's own border", () => {
    expect(resizeEdgeFor("sidebar", "right")).toBe("sidebar");
    expect(resizeEdgeFor("panel", "left")).toBe("right-panel");
    expect(resizeEdgeFor("panel", "right")).toBe("right-panel");
  });

  it("moves the sidebar's border from the chat when no panel is open", () => {
    expect(resizeEdgeFor("chat", "right")).toBe("sidebar");
  });

  it("moves the terminal drawer's border vertically, from the chat column only", () => {
    expect(resizeEdgeFor("chat", "up")).toBe("terminal-drawer");
    expect(resizeEdgeFor("terminal", "down")).toBe("terminal-drawer");
    expect(resizeEdgeFor("sidebar", "up")).toBeNull();
    expect(resizeEdgeFor("panel", "down")).toBeNull();
  });
});

describe("PANE mode on the right panel", () => {
  // Regression: the first build grew the focused pane, so `l` on the right
  // panel moved its border left. The border must follow the key.
  it("narrows the panel on l and widens it on h", () => {
    expect(borderMoveDelta("left", "right", 10)).toBe(-10);
    expect(borderMoveDelta("left", "left", 10)).toBe(10);
  });
});

describe("movePaneEdgeBorder", () => {
  const STEP_X = paneEdgeStep("left", { width: window.innerWidth, height: window.innerHeight });

  function fakeEdge(side: PaneEdgeSide, size: number) {
    const sizes: number[] = [];
    const edge: PaneEdge = {
      id: "sidebar",
      side,
      size: () => size,
      resizeTo: (next) => {
        sizes.push(next);
        return next;
      },
      reset: () => {},
    };
    return { edge, sizes };
  }

  it("resizes an edge by whole viewport steps in the border's direction", () => {
    const { edge, sizes } = fakeEdge("right", 300);
    expect(movePaneEdgeBorder(edge, "right", 2)).toBe(true);
    expect(sizes).toEqual([300 + 2 * STEP_X]);
  });

  it("leaves an edge alone for a direction across its axis", () => {
    const { edge, sizes } = fakeEdge("left", 300);
    expect(movePaneEdgeBorder(edge, "up", 1)).toBe(false);
    expect(sizes).toEqual([]);
  });
});

describe("usePaneEdge registration and separator keys", () => {
  let root: Root;
  const sizes: Array<readonly [string, number]> = [];

  function Separator(props: {
    readonly id: PaneEdgeId;
    readonly name: string;
    readonly side: PaneEdgeSide;
    readonly enabled: boolean;
  }) {
    const separator = usePaneEdge({
      id: props.id,
      side: props.side,
      enabled: props.enabled,
      size: () => 400,
      resizeTo: (size) => {
        sizes.push([props.name, size]);
        return size;
      },
      reset: () => {},
    });
    return createElement("div", { role: "separator", "data-name": props.name, ...separator });
  }

  function render(separators: ReadonlyArray<Parameters<typeof Separator>[0]>): void {
    act(() =>
      root.render(
        separators.map((props) => createElement(Separator, { key: props.name, ...props })),
      ),
    );
  }

  function pressArrow(name: string, key: string): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    act(() => {
      document.querySelector(`[data-name="${name}"]`)!.dispatchEvent(event);
    });
    return event;
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    sizes.length = 0;
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("registers an edge only while it is enabled", () => {
    render([{ id: "right-panel", name: "panel", side: "left", enabled: false }]);
    expect(getPaneEdge("right-panel")).toBeNull();
    render([{ id: "right-panel", name: "panel", side: "left", enabled: true }]);
    expect(getPaneEdge("right-panel")).not.toBeNull();
    render([]);
    expect(getPaneEdge("right-panel")).toBeNull();
  });

  it("keeps the first mount of an edge when a second mount of it unmounts", () => {
    render([
      { id: "right-panel", name: "first", side: "left", enabled: true },
      { id: "right-panel", name: "second", side: "left", enabled: true },
    ]);
    getPaneEdge("right-panel")!.resizeTo(1);
    render([{ id: "right-panel", name: "first", side: "left", enabled: true }]);
    getPaneEdge("right-panel")!.resizeTo(2);
    expect(sizes).toEqual([
      ["second", 1],
      ["first", 2],
    ]);
  });

  it("moves the border with the arrow key on a focused separator", () => {
    render([{ id: "right-panel", name: "panel", side: "left", enabled: true }]);
    const step = paneEdgeStep("left", { width: window.innerWidth, height: window.innerHeight });

    expect(pressArrow("panel", "ArrowRight").defaultPrevented).toBe(true);
    expect(pressArrow("panel", "ArrowLeft").defaultPrevented).toBe(true);
    expect(pressArrow("panel", "ArrowUp").defaultPrevented).toBe(false);
    expect(sizes).toEqual([
      ["panel", 400 - step],
      ["panel", 400 + step],
    ]);
  });
});
