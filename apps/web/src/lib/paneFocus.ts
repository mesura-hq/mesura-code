// Reads the pane from `document.activeElement`, never from stored state, which
// could only disagree with it. The roots are attributes the app already renders;
// renaming one makes that pane unreachable and breaks nothing else.

export type PaneId = "sidebar" | "chat" | "panel" | "terminal";
export type PaneDirection = "left" | "right" | "up" | "down";

/**
 * The horizontal panes, left to right. The terminal drawer is absent on
 * purpose: it is the chat column's vertical neighbour, never a column of its
 * own, so a horizontal step from it starts at the chat.
 */
export const PANE_ORDER: ReadonlyArray<PaneId> = ["sidebar", "chat", "panel"];

/** The terminal drawer's root, shared with the pane mark in `drawerFocusMark.ts`. */
export const TERMINAL_DRAWER_SELECTOR = '[data-terminal-owner="drawer"]';

const PANE_ROOT_SELECTOR: Record<PaneId, string> = {
  sidebar: "[data-app-sidebar]",
  chat: "[data-chat-column-maximized-away]",
  panel: "[data-preview-panel-mode]",
  terminal: TERMINAL_DRAWER_SELECTOR,
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
  // A thread row first: `[data-sidebar="menu-button"]` is the toolbar's icon
  // buttons, and once landed the keyboard on the collapse toggle. The `<li>` is
  // not focusable, so the row is its `role="button"`. The route registers the
  // active row through `registerPaneEntry`; these are the fallback.
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
  // The fallback only: the mounted panel registers `enterPanel`
  // (`panelSurfaceFocus.ts`), which lands in the active surface's content.
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

  const pane = paneContaining(activeElement);
  if (pane !== null) lastFocusedPane = pane;
  return pane;
}

/** The innermost pane whose root contains `element`. */
function paneContaining(element: Element): PaneId | null {
  for (const pane of CONTAINMENT_ORDER) {
    if (element.closest(PANE_ROOT_SELECTOR[pane]) !== null) return pane;
  }
  return null;
}

/**
 * Records a pointer press as entering the pane it lands in. A click on a
 * pane's plain text focuses nothing, so focus falls to <body> and no focus
 * event names the pane, yet the keys that follow are meant for it: a click
 * on the chat's text after the sidebar hands the keys to the chat.
 */
export function notePointerPane(target: EventTarget | null): void {
  if (!(target instanceof Element)) return;
  const pane = paneContaining(target);
  if (pane !== null) lastFocusedPane = pane;
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
    // Collapse state lives on the `[data-slot="sidebar"]` parent (upstream's own
    // CSS hook); the inner container keeps its width and only slides off-screen.
    // No such parent means `collapsible="none"`, unused here: answer unreachable,
    // since focusing an off-screen sidebar strands the keyboard.
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

// The sidebar's bare `j`/`k` chords must yield to any text entry inside it, not
// one named search box: the thread search and the project filter are separate
// inputs, and a rule keyed to one stops guarding the other.
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
