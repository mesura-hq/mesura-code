// @vitest-environment happy-dom
// Entry point: `handlePaneKey` (`paneMode.ts`), which the key engine hands
// every key while PANE mode is active. The three edges register through
// `usePaneEdge`, as the sidebar rail, the right panel and the terminal drawer
// do, so a spec sees the size each owner's `resizeTo` would receive. Focus
// sits in the pane roots the app renders (`paneFocus.ts`).
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { usePaneEdge, type PaneEdgeId, type PaneEdgeSide } from "~/lib/paneEdges";
import { readKeyEngineSnapshot } from "./keyEngineStore";
import { handlePaneKey, isPaneModeActive, startPaneMode, stopPaneMode } from "./paneMode";

const LAYOUT = `
  <div data-app-sidebar><button data-testid="sidebar-row">row</button></div>
  <div data-chat-column-maximized-away="false">
    <div data-testid="chat-focus" tabindex="0">chat</div>
  </div>
  <div data-preview-panel-mode="inline"><button data-testid="panel-button">refresh</button></div>`;

/** happy-dom's default viewport is 1024 x 768: one step is 51 px across, 38 px down. */
const STEP_X = Math.round(window.innerWidth * 0.05);
const STEP_Y = Math.round(window.innerHeight * 0.05);

const EDGES: ReadonlyArray<{
  readonly id: PaneEdgeId;
  readonly side: PaneEdgeSide;
  readonly size: number;
}> = [
  { id: "sidebar", side: "right", size: 300 },
  { id: "right-panel", side: "left", size: 500 },
  { id: "terminal-drawer", side: "top", size: 200 },
];

const resized: Array<readonly [PaneEdgeId, number]> = [];
const resets: PaneEdgeId[] = [];

function EdgeProbe(props: {
  readonly id: PaneEdgeId;
  readonly side: PaneEdgeSide;
  readonly size: number;
  readonly enabled: boolean;
}) {
  usePaneEdge({
    id: props.id,
    side: props.side,
    enabled: props.enabled,
    size: () => props.size,
    resizeTo: (size) => {
      resized.push([props.id, size]);
      return size;
    },
    reset: () => resets.push(props.id),
  });
  return null;
}

let root: Root;

/** Renders the three edges; a closed right panel unregisters its edge, as `PreviewPanelShell` does. */
function mountEdges(options: { readonly panelOpen: boolean } = { panelOpen: true }): void {
  act(() =>
    root.render(
      EDGES.map((edge) =>
        createElement(EdgeProbe, {
          key: edge.id,
          ...edge,
          enabled: edge.id !== "right-panel" || options.panelOpen,
        }),
      ),
    ),
  );
}

function focus(testId: string): void {
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.focus();
}

/** Enters PANE mode and types the keys, as `<leader>w` and then the keys do. */
function paneKeys(...tokens: string[]): void {
  startPaneMode();
  for (const token of tokens) expect(handlePaneKey(token)).toBe(true);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.innerHTML = LAYOUT;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  resized.length = 0;
  resets.length = 0;
});

afterEach(() => {
  stopPaneMode();
  act(() => root.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("PANE mode border keys", () => {
  it("moves the sidebar border in the key's direction from the sidebar", () => {
    mountEdges();
    focus("sidebar-row");
    paneKeys("l", "h");
    expect(resized).toEqual([
      ["sidebar", 300 + STEP_X],
      ["sidebar", 300 - STEP_X],
    ]);
  });

  // The right panel's border is on its left: `l` moves it right, which
  // narrows the panel. The first build grew the focused pane instead.
  it("moves the right panel border in the key's direction from the right panel", () => {
    mountEdges();
    focus("panel-button");
    paneKeys("l", "h");
    expect(resized).toEqual([
      ["right-panel", 500 - STEP_X],
      ["right-panel", 500 + STEP_X],
    ]);
  });

  it("moves the right panel border from the chat while the panel is open", () => {
    mountEdges({ panelOpen: true });
    focus("chat-focus");
    paneKeys("l");
    expect(resized).toEqual([["right-panel", 500 - STEP_X]]);
  });

  it("moves the sidebar border from the chat while the panel is closed", () => {
    mountEdges({ panelOpen: false });
    focus("chat-focus");
    paneKeys("l");
    expect(resized).toEqual([["sidebar", 300 + STEP_X]]);
  });

  it("moves the terminal drawer border up and down from the chat", () => {
    mountEdges();
    focus("chat-focus");
    paneKeys("k", "j");
    expect(resized).toEqual([
      ["terminal-drawer", 200 + STEP_Y],
      ["terminal-drawer", 200 - STEP_Y],
    ]);
  });

  it("multiplies the step by a count typed before the key", () => {
    mountEdges();
    focus("sidebar-row");
    paneKeys("3", "l");
    expect(resized).toEqual([["sidebar", 300 + 3 * STEP_X]]);
    expect(readKeyEngineSnapshot().pending).toEqual([]);
  });

  it("reports a vertical key with no border from the sidebar and stays in PANE mode", () => {
    mountEdges();
    focus("sidebar-row");
    paneKeys("j");
    expect(resized).toEqual([]);
    expect(readKeyEngineSnapshot().notice).toBe("no border to move down from the sidebar");
    expect(isPaneModeActive()).toBe(true);
  });
});

describe("PANE mode reset and exit", () => {
  it("resets every registered edge on =", () => {
    mountEdges();
    focus("chat-focus");
    paneKeys("=");
    expect(resets.toSorted()).toEqual(["right-panel", "sidebar", "terminal-drawer"]);
    expect(resized).toEqual([]);
  });

  it("stays in PANE mode across moves and leaves on Escape, q or Enter", () => {
    mountEdges();
    focus("sidebar-row");
    for (const exit of ["<Esc>", "q", "<CR>"]) {
      paneKeys("l", "l");
      expect(isPaneModeActive()).toBe(true);
      expect(handlePaneKey(exit)).toBe(true);
      expect(isPaneModeActive()).toBe(false);
    }
  });

  it("leaves PANE mode on an unknown key and hands the key back", () => {
    mountEdges();
    focus("sidebar-row");
    startPaneMode();
    expect(handlePaneKey("i")).toBe(false);
    expect(isPaneModeActive()).toBe(false);
    expect(resized).toEqual([]);
  });
});
