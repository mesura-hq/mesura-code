import {
  getPaneEdge,
  getPaneEdges,
  movePaneEdgeBorder,
  type BorderDirection,
  type PaneEdgeId,
} from "~/lib/paneEdges";
import { getFocusedPane, getLastFocusedPane, type PaneId } from "~/lib/paneFocus";

import { updateKeyEngineSnapshot } from "./keyEngineStore";

/**
 * Sticky, as Helix's sticky modes are; an unknown key leaves and then runs as in normal mode.
 * A key moves a border in its own screen direction, as tmux's `resize-pane` does; the focused pane
 * only picks which border. "Grow the focused pane" once made `l` move the right panel's border
 * left, against the key: do not reintroduce a per-pane sign.
 */

/** Which border a key moves from the pane. `null` when the pane has none on that axis. */
export function resizeEdgeFor(pane: PaneId, direction: BorderDirection): PaneEdgeId | null {
  if (direction === "up" || direction === "down") {
    return pane === "chat" || pane === "terminal" ? "terminal-drawer" : null;
  }
  if (pane === "sidebar") return "sidebar";
  if (pane === "panel") return "right-panel";
  // The chat column, with the terminal drawer inside it.
  return getPaneEdge("right-panel") ? "right-panel" : "sidebar";
}

const KEY_DIRECTIONS: Record<string, BorderDirection> = {
  h: "left",
  l: "right",
  k: "up",
  j: "down",
};

let active = false;
let count = "";

export function isPaneModeActive(): boolean {
  return active;
}

export function startPaneMode(): void {
  active = true;
  count = "";
}

export function stopPaneMode(): void {
  active = false;
  count = "";
  updateKeyEngineSnapshot({ pending: [] });
}

/**
 * Every key while PANE mode is active comes here. Returns false for a key
 * that only ended the mode, which the engine then routes as usual.
 */
export function handlePaneKey(token: string): boolean {
  if (token === "<Esc>" || token === "<CR>" || token === "q") {
    stopPaneMode();
    return true;
  }
  if (/^[0-9]$/.test(token) && (token !== "0" || count.length > 0)) {
    count += token;
    updateKeyEngineSnapshot({ pending: [count] });
    return true;
  }
  const steps = count.length > 0 ? Number(count) : 1;
  count = "";
  updateKeyEngineSnapshot({ pending: [] });
  const direction = KEY_DIRECTIONS[token];
  if (direction !== undefined) return moveBorder(direction, steps);
  if (token === "=") {
    for (const edge of getPaneEdges()) edge.reset();
    return true;
  }
  stopPaneMode();
  return false;
}

function moveBorder(direction: BorderDirection, steps: number): boolean {
  const pane = getFocusedPane() ?? getLastFocusedPane();
  const edgeId = resizeEdgeFor(pane, direction);
  const edge = edgeId ? getPaneEdge(edgeId) : null;
  if (!edge) {
    updateKeyEngineSnapshot({ notice: `no border to move ${direction} from the ${pane}` });
    return true;
  }
  movePaneEdgeBorder(edge, direction, steps);
  return true;
}
