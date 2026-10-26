// The edges register through `usePaneEdge` as their real owners do, so a spec
// sees the size each owner's `resizeTo` would receive.
import { createElement } from "react";
import { describe, expect, it } from "vite-plus/test";

import { render, fakeTimers } from "../../test/render";
import { mountKeyDom } from "~/test/keyBrowserFixtures";

import { usePaneEdge, type PaneEdgeId, type PaneEdgeSide } from "~/lib/paneEdges";
import { readKeyEngineSnapshot } from "./keyEngineStore";
import { handlePaneKey, isPaneModeActive, startPaneMode, stopPaneMode } from "./paneMode";

const LAYOUT = `
  <div data-app-sidebar><button data-testid="sidebar-row">row</button></div>
  <div data-chat-column-maximized-away="false">
    <div data-testid="chat-focus" tabindex="0">chat</div>
  </div>
  <div data-preview-panel-mode="inline"><button data-testid="panel-button">refresh</button></div>`;

/** Each move is five percent of Chromium's current viewport. */
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

function EdgeProbe(props: {
  readonly id: PaneEdgeId;
  readonly side: PaneEdgeSide;
  readonly size: number;
  readonly enabled: boolean;
  readonly onResize: (id: PaneEdgeId, size: number) => void;
  readonly onReset: (id: PaneEdgeId) => void;
}) {
  usePaneEdge({
    id: props.id,
    side: props.side,
    enabled: props.enabled,
    size: () => props.size,
    resizeTo: (size) => {
      props.onResize(props.id, size);
      return size;
    },
    reset: () => props.onReset(props.id),
  });
  return null;
}

/** A closed right panel unregisters its edge, as `PreviewPanelShell` does. */
async function mountEdges(options: { readonly panelOpen: boolean } = { panelOpen: true }) {
  await using stack = new AsyncDisposableStack();
  stack.use(mountKeyDom(LAYOUT));
  const resized: Array<readonly [PaneEdgeId, number]> = [];
  const resets: PaneEdgeId[] = [];
  stack.use(
    await render(
      EDGES.map((edge) =>
        createElement(EdgeProbe, {
          key: edge.id,
          ...edge,
          enabled: edge.id !== "right-panel" || options.panelOpen,
          onResize: (id, size) => {
            resized.push([id, size]);
          },
          onReset: (id) => {
            resets.push(id);
          },
        }),
      ),
    ),
  );
  stack.use(fakeTimers());
  stack.defer(stopPaneMode);
  const lifetime = stack.move();
  return {
    resized,
    resets,
    [Symbol.asyncDispose]: () => lifetime.disposeAsync(),
  };
}

function focus(testId: string): void {
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.focus();
}

/** Enters PANE mode and types the keys, as `<leader>w` and then the keys do. */
function paneKeys(...tokens: string[]): void {
  startPaneMode();
  for (const token of tokens) expect(handlePaneKey(token)).toBe(true);
}

describe("PANE mode border keys", () => {
  it("moves the sidebar border in the key's direction from the sidebar", async () => {
    await using fixture = await mountEdges();
    focus("sidebar-row");
    paneKeys("l", "h");
    expect(fixture.resized).toEqual([
      ["sidebar", 300 + STEP_X],
      ["sidebar", 300 - STEP_X],
    ]);
  });

  // The right panel's border is on its left: `l` moves it right, which
  // narrows the panel. The first build grew the focused pane instead.
  it("moves the right panel border in the key's direction from the right panel", async () => {
    await using fixture = await mountEdges();
    focus("panel-button");
    paneKeys("l", "h");
    expect(fixture.resized).toEqual([
      ["right-panel", 500 - STEP_X],
      ["right-panel", 500 + STEP_X],
    ]);
  });

  it("moves the right panel border from the chat while the panel is open", async () => {
    await using fixture = await mountEdges({ panelOpen: true });
    focus("chat-focus");
    paneKeys("l");
    expect(fixture.resized).toEqual([["right-panel", 500 - STEP_X]]);
  });

  it("moves the sidebar border from the chat while the panel is closed", async () => {
    await using fixture = await mountEdges({ panelOpen: false });
    focus("chat-focus");
    paneKeys("l");
    expect(fixture.resized).toEqual([["sidebar", 300 + STEP_X]]);
  });

  it("moves the terminal drawer border up and down from the chat", async () => {
    await using fixture = await mountEdges();
    focus("chat-focus");
    paneKeys("k", "j");
    expect(fixture.resized).toEqual([
      ["terminal-drawer", 200 + STEP_Y],
      ["terminal-drawer", 200 - STEP_Y],
    ]);
  });

  it("multiplies the step by a count typed before the key", async () => {
    await using fixture = await mountEdges();
    focus("sidebar-row");
    paneKeys("3", "l");
    expect(fixture.resized).toEqual([["sidebar", 300 + 3 * STEP_X]]);
    expect(readKeyEngineSnapshot().pending).toEqual([]);
  });

  it("reports a vertical key with no border from the sidebar and stays in PANE mode", async () => {
    await using fixture = await mountEdges();
    focus("sidebar-row");
    paneKeys("j");
    expect(fixture.resized).toEqual([]);
    expect(readKeyEngineSnapshot().notice).toBe("no border to move down from the sidebar");
    expect(isPaneModeActive()).toBe(true);
  });
});

describe("PANE mode reset and exit", () => {
  it("resets every registered edge on =", async () => {
    await using fixture = await mountEdges();
    focus("chat-focus");
    paneKeys("=");
    expect(fixture.resets.toSorted()).toEqual(["right-panel", "sidebar", "terminal-drawer"]);
    expect(fixture.resized).toEqual([]);
  });

  it("stays in PANE mode across moves and leaves on Escape, q or Enter", async () => {
    await using _fixture = await mountEdges();
    focus("sidebar-row");
    for (const exit of ["<Esc>", "q", "<CR>"]) {
      paneKeys("l", "l");
      expect(isPaneModeActive()).toBe(true);
      expect(handlePaneKey(exit)).toBe(true);
      expect(isPaneModeActive()).toBe(false);
    }
  });

  it("leaves PANE mode on an unknown key and hands the key back", async () => {
    await using fixture = await mountEdges();
    focus("sidebar-row");
    startPaneMode();
    expect(handlePaneKey("i")).toBe(false);
    expect(isPaneModeActive()).toBe(false);
    expect(fixture.resized).toEqual([]);
  });
});
