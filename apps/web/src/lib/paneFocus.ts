/**
 * Which pane owns the keyboard, read from the browser's own focus tree.
 *
 * Nothing here is state. `document.activeElement` is already the truth about
 * where a keystroke will be delivered, so a stored copy could only ever
 * disagree with it. This mirrors `terminalFocus.ts` and `previewFocus.ts`,
 * which answer the same question for one surface each.
 *
 * The roots are attributes the app already renders, so no component gains an
 * attribute for this: `[data-app-sidebar]` (AppSidebarLayout),
 * `[data-chat-column-maximized-away]` (ChatView), `[data-terminal-owner]`
 * (ThreadTerminalDrawer) and `[data-preview-panel-mode]` (PreviewPanelShell).
 * If one is renamed, that pane stops being reachable and nothing else breaks.
 */

export type PaneId = "sidebar" | "chat" | "panel" | "terminal";
export type PaneDirection = "left" | "right" | "up" | "down";

/**
 * The horizontal panes, left to right. The terminal drawer is absent on
 * purpose: it is the chat column's vertical neighbour, never a column of its
 * own, so a horizontal step from it starts at the chat.
 */
export const PANE_ORDER: ReadonlyArray<PaneId> = ["sidebar", "chat", "panel"];

const PANE_ROOT_SELECTOR: Record<PaneId, string> = {
  sidebar: "[data-app-sidebar]",
  chat: "[data-chat-column-maximized-away]",
  panel: "[data-preview-panel-mode]",
  terminal: '[data-terminal-owner="drawer"]',
};

/**
 * Most-contained root first. The drawer is rendered inside the chat column,
 * so a walk that tested the chat first would report `chat` for a focused
 * terminal and send its keys to the wrong place.
 */
const CONTAINMENT_ORDER: ReadonlyArray<PaneId> = ["terminal", "sidebar", "panel", "chat"];

/**
 * Where focus lands when it enters a pane, in preference order.
 *
 * Each of these is the element that owns the pane's key handling. Focusing a
 * wrapper instead would satisfy `:focus-within` and then swallow every
 * keystroke, which looks identical to the feature not working.
 */
const PANE_ENTRY_SELECTORS: Record<PaneId, ReadonlyArray<string>> = {
  // A thread row before anything else. The rows are what the sidebar is for,
  // and the `[data-sidebar="menu-button"]` elements are the six icon buttons
  // in the top and bottom bars — verified in the running app, where the
  // original selector landed the keyboard on the collapse toggle. The row
  // itself is the `role="button"` inside the `<li>`: the `<li>` carries the
  // key but is not focusable.
  //
  // Which row is a question this module cannot answer, so the route
  // registers the active one through `registerPaneEntry` and these are the
  // fallback for when it has not.
  sidebar: [
    '[data-app-sidebar] [data-thread-item] [role="button"]',
    '[data-app-sidebar] [data-sidebar="menu-button"]',
  ],
  // The composer is a contenteditable div, not a textarea; the textarea is
  // the fallback for surfaces that still use one.
  chat: [
    '[data-chat-column-maximized-away] [contenteditable="true"]',
    "[data-chat-column-maximized-away] textarea",
  ],
  // Asked in type order rather than document order, deliberately: the Files
  // surface renders its refresh button before its search box, and the search
  // box is where someone arriving by keyboard wants to be. A single combined
  // selector would give document order and land on the refresh button.
  panel: [
    "[data-preview-panel-mode] input",
    "[data-preview-panel-mode] textarea",
    "[data-preview-panel-mode] button",
    '[data-preview-panel-mode] [tabindex]:not([tabindex="-1"])',
    "[data-preview-panel-mode] a[href]",
  ],
  // xterm's helper textarea, which is what actually receives terminal keys.
  terminal: ['[data-terminal-owner="drawer"] textarea'],
};

/**
 * Entries a surface registered for itself, which beat the selectors above.
 *
 * Monaco is the case this exists for: its focusable element moves depending
 * on whether `editContext` is on, so the editor names its own entry rather
 * than having this module guess at a selector that changes under it.
 */
const registeredEntries = new Map<PaneId, () => boolean>();

/**
 * The pane focus was in most recently.
 *
 * Blurring to `<body>` is ordinary — leaving Neovim's normal mode does it —
 * and a chord typed in that state still has to mean something. Never
 * persisted: a pane is a transient view position, not an identity.
 */
let lastFocusedPane: PaneId = "chat";

function paneRoot(pane: PaneId): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(PANE_ROOT_SELECTOR[pane]);
}

/** The pane containing the element that currently has the keyboard. */
export function getFocusedPane(): PaneId | null {
  if (typeof document === "undefined") return null;
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return null;
  if (!activeElement.isConnected) return null;

  for (const pane of CONTAINMENT_ORDER) {
    if (activeElement.closest(PANE_ROOT_SELECTOR[pane]) !== null) {
      lastFocusedPane = pane;
      return pane;
    }
  }
  return null;
}

/** The last pane that held focus, for when nothing holds it now. */
export function getLastFocusedPane(): PaneId {
  return lastFocusedPane;
}

/**
 * Whether a pane is present and open enough to receive focus.
 *
 * A pane that is rendered but collapsed, maximized away, or showing as a
 * sheet cannot hold the keyboard, and focusing it would drop focus on the
 * floor with no way back except the mouse.
 */
export function isPaneReachable(pane: PaneId): boolean {
  const root = paneRoot(pane);
  if (root === null) return false;

  switch (pane) {
    // `data-app-sidebar` lands on the inner `sidebar-container` div, and the
    // collapsed state is on its `[data-slot="sidebar"]` parent — verified in
    // the running app, where the container keeps its full width and merely
    // slides off-screen, so neither its own dataset nor its width can answer
    // this. That parent is the hook upstream's own CSS selects on, so it
    // cannot be renamed there without upstream noticing.
    //
    // No such parent means a sidebar rendered `collapsible="none"`, which
    // this app does not use. Unreachable is the safe answer: focusing a
    // sidebar that turns out to be off-screen strands the keyboard with no
    // way back except the mouse.
    case "sidebar": {
      const stateHost = root.closest<HTMLElement>('[data-slot="sidebar"]');
      return stateHost !== null && stateHost.dataset.state !== "collapsed";
    }
    case "chat":
      return root.dataset.chatColumnMaximizedAway !== "true";
    case "panel":
      return root.dataset.previewPanelMode === "inline";
    case "terminal":
      return true;
    default: {
      // A PaneId added later fails the typecheck here rather than silently
      // reporting a pane nobody can reach.
      const unhandled: never = pane;
      return unhandled;
    }
  }
}

/**
 * The next reachable pane in a direction, or null at the edge.
 *
 * Directional and never wrapping: a chord whose effect depends on invisible
 * state is worse than one that does nothing.
 */
export function neighbourOf(pane: PaneId, direction: PaneDirection): PaneId | null {
  // Vertically there is one neighbour pair in the whole layout: the chat
  // column and the terminal drawer beneath it. The sidebar and the right
  // panel are single panes top to bottom, so a vertical chord has nothing to
  // do there and says so by returning null.
  if (direction === "down") {
    return pane === "chat" && isPaneReachable("terminal") ? "terminal" : null;
  }
  if (direction === "up") {
    return pane === "terminal" && isPaneReachable("chat") ? "chat" : null;
  }

  const column: PaneId = pane === "terminal" ? "chat" : pane;
  const index = PANE_ORDER.indexOf(column);
  if (index === -1) return null;

  const step = direction === "left" ? -1 : 1;
  for (let next = index + step; next >= 0 && next < PANE_ORDER.length; next += step) {
    const candidate = PANE_ORDER[next];
    if (candidate !== undefined && isPaneReachable(candidate)) return candidate;
  }
  return null;
}

/**
 * Puts the keyboard into a pane. Returns whether anything took the focus.
 *
 * A false here is worth acting on: it means the pane had no entry, and the
 * caller should leave focus where it was rather than strand it.
 */
export function focusPane(pane: PaneId): boolean {
  const registered = registeredEntries.get(pane);
  if (registered !== undefined && registered()) {
    lastFocusedPane = pane;
    return true;
  }

  if (typeof document === "undefined") return false;
  for (const selector of PANE_ENTRY_SELECTORS[pane]) {
    const entry = document.querySelector<HTMLElement>(selector);
    if (entry !== null) {
      entry.focus({ preventScroll: true });
      // Recorded here rather than waiting for the next read: two chords in a
      // row with no resolve between them would otherwise both step from the
      // pane the first one left.
      lastFocusedPane = pane;
      return true;
    }
  }
  return false;
}

/** Elements a keystroke goes into rather than through. */
const TEXT_ENTRY_TAGS: ReadonlySet<string> = new Set(["INPUT", "TEXTAREA"]);

/**
 * Whether the keyboard is in something you type into, inside the sidebar.
 *
 * The sidebar's list chords are the only bare letters in the app: `j` and `k`
 * walk the thread list. So something has to say when the sidebar holds the
 * keyboard and a letter is nonetheless meant to be a letter.
 *
 * Asked of any text entry rather than of one named search box. The sidebar
 * renders two — the thread search and the project filter — and a rule keyed
 * to either would silently stop guarding the other the day upstream adds a
 * third.
 */
export function isSidebarSearchFocused(): boolean {
  if (typeof document === "undefined") return false;
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return false;
  if (!activeElement.isConnected) return false;
  if (!TEXT_ENTRY_TAGS.has(activeElement.tagName) && !activeElement.isContentEditable) {
    return false;
  }
  return activeElement.closest(PANE_ROOT_SELECTOR.sidebar) !== null;
}

/**
 * Lets a surface name its own focus entry, beating the selector fallbacks.
 * Returns the function that takes it back out again.
 */
export function registerPaneEntry(pane: PaneId, focus: () => boolean): () => void {
  registeredEntries.set(pane, focus);
  return () => {
    if (registeredEntries.get(pane) === focus) registeredEntries.delete(pane);
  };
}
