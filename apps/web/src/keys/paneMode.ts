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
 * PANE mode: resize the panes from the keyboard, entered with `<leader>w`.
 *
 * The mode is sticky, as Helix's sticky modes and Emacs's hydras are: `l l l`
 * moves three steps without the leader again. It leaves on `Esc`, `q` or
 * Enter; any other key leaves too and then runs as it would in normal mode,
 * so `i` after a resize still enters the composer.
 *
 * The keys move a border in their own direction, as tmux's `resize-pane -L`
 * and the arrow keys on a focused separator do: `h` left, `l` right, `k` up,
 * `j` down. The focused pane (or the last focused one, after a blur to
 * `<body>`) only picks which border:
 *
 * - sidebar: its right edge. `l` widens it.
 * - right panel: its left edge. `h` widens it, `l` narrows it.
 * - chat: the right panel's edge when the panel is open, otherwise the
 *   sidebar's; for `j` / `k`, the terminal drawer's top edge.
 *
 * A count multiplies the step (5% of the viewport): `3l`. `=` puts every edge
 * back to its default size, as Neovim's `<C-w>=` evens out every window.
 *
 * Why not "grow the focused pane" (Hyprland's `resizeactive`): the first
 * build did that, and on the right panel `l` then moved the border left,
 * against the key. The developer reads these keys as directions on screen,
 * so the border follows the key in every pane. Do not reintroduce a per-pane
 * sign.
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
