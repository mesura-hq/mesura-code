/**
 * Where the keyboard lands in the right panel: in the active surface's content,
 * on the element that owns its keys (a tree, an editor, a diff, a terminal),
 * never on a tab title or a toolbar button. Every keyboard way into the panel
 * comes here — `Ctrl+L` and the other pane moves, a launcher letter, `Ctrl+Tab`,
 * a close — so a surface is navigable the moment it shows, with no click first.
 *
 * A surface marks its entry with `data-pane-entry`; the value ranks entries
 * when a surface shows more than one (the editor beside its file tree), and
 * the highest visible one wins, then document order. An entry that is not
 * focusable itself gets its scroll region focused, so the arrows scroll it; an
 * entry whose keys live deeper (a tree that renders its rows in a shadow root)
 * names its own focus with `setPaneEntryFocus`. In a focused scroll region,
 * `Ctrl+D` / `Ctrl+U` scroll half a page unless the surface took them first.
 */

import { useEffect, type RefObject } from "react";

import { getFocusedPane, getLastFocusedPane, registerPaneEntry } from "./paneFocus";

export const PANE_ENTRY_ATTRIBUTE = "data-pane-entry";
const PANEL_ROOT_SELECTOR = "[data-preview-panel-mode]";
const SURFACE_CONTENT_SELECTOR = "[data-right-panel-surface-content]";
/** xterm's helper textarea: what receives a terminal surface's keys. */
const TERMINAL_INPUT_SELECTOR = ".xterm-helper-textarea";
/** The active tab's title button: where focus waits while a surface renders. */
export const ACTIVE_TAB_TITLE_SELECTOR =
  '[data-right-panel-tabbar] [data-active-tab="true"] button:not([aria-label])';
/** Frames to wait for the panel to render its new active tab after a key. */
const ACTIVE_TAB_WAIT_FRAMES = 10;
/**
 * How long a surface may take to render its entry after its tab shows. The
 * Diff and the trees load lazily and then load their data; a surface still
 * empty after this keeps focus on its tab title.
 */
const ENTRY_WAIT_MS = 4000;

const customFocus = new WeakMap<Element, () => boolean>();

/** Gives an entry element its own focus; the returned function takes it back. */
export function setPaneEntryFocus(element: Element, focus: () => boolean): () => void {
  customFocus.set(element, focus);
  return () => {
    if (customFocus.get(element) === focus) customFocus.delete(element);
  };
}

function isShown(element: Element): boolean {
  return element.getClientRects().length > 0;
}

function entryRank(element: Element): number {
  const rank = Number(element.getAttribute(PANE_ENTRY_ATTRIBUTE));
  return Number.isFinite(rank) ? rank : 0;
}

const isScrollRegion = (element: Element) =>
  /^(auto|scroll)$/.test(getComputedStyle(element).overflowY);
/** How deep under an entry its scroll region may sit. */
const SCROLL_REGION_MAX_DEPTH = 4;

/** The entry's own scroll region, searched breadth first a few levels down. */
function scrollRegionIn(entry: HTMLElement): HTMLElement | null {
  let level: Element[] = [entry];
  for (let depth = 0; depth <= SCROLL_REGION_MAX_DEPTH && level.length > 0; depth++) {
    const region = level.find(isScrollRegion);
    if (region instanceof HTMLElement) return region;
    level = level.flatMap((element) => [...element.children]);
  }
  return null;
}

function focusEntry(entry: HTMLElement): boolean {
  const own = customFocus.get(entry);
  if (own) return own();
  // No scroll region yet means the surface is still loading; the wait for
  // the entry goes on.
  const target = entry.hasAttribute("tabindex") ? entry : scrollRegionIn(entry);
  if (target === null) return false;
  if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
  target.focus({ preventScroll: true });
  return entry.contains(document.activeElement);
}

/** Puts focus on the active surface's entry in `panel`; false when it shows none. */
export function focusPanelSurface(panel: Element): boolean {
  const content = panel.querySelector(SURFACE_CONTENT_SELECTOR);
  if (content === null) return false;
  const entries = [...content.querySelectorAll<HTMLElement>(`[${PANE_ENTRY_ATTRIBUTE}]`)]
    .filter(isShown)
    // A stable sort, so equal ranks keep document order.
    .toSorted((left, right) => entryRank(right) - entryRank(left));
  for (const entry of entries) {
    if (focusEntry(entry)) return true;
  }
  const terminal = content.querySelector<HTMLElement>(TERMINAL_INPUT_SELECTOR);
  if (terminal !== null && isShown(terminal.parentElement ?? terminal)) {
    terminal.focus({ preventScroll: true });
    return document.activeElement === terminal;
  }
  return false;
}

/** The pane entry for `focusPane("panel")`: the surface, else its tab title. */
export function enterPanel(): boolean {
  const panel = document.querySelector(PANEL_ROOT_SELECTOR);
  if (panel === null) return false;
  if (focusPanelSurface(panel)) return true;
  const title = panel.querySelector<HTMLElement>(ACTIVE_TAB_TITLE_SELECTOR);
  title?.focus({ preventScroll: true });
  return title !== null;
}

const isTextEntry = (element: HTMLElement) =>
  element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName);

/** The scroll region that holds `element` inside a surface, if it can scroll. */
function scrollRegionAround(element: HTMLElement, content: Element): HTMLElement | null {
  for (let node: HTMLElement | null = element; node && content.contains(node);) {
    if (node.scrollHeight > node.clientHeight && isScrollRegion(node)) return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * `Ctrl+D` / `Ctrl+U` in a surface's scroll region. Bubble phase, so a surface
 * with its own half-page move (a tree, the editor, the terminal) answers first;
 * text entries keep the keys.
 */
function onHalfPageKey(event: KeyboardEvent): void {
  const direction = halfPageDirection(event);
  if (direction === null || event.defaultPrevented) return;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || isTextEntry(active)) return;
  const content = active.closest(SURFACE_CONTENT_SELECTOR);
  const region = content ? scrollRegionAround(active, content) : null;
  if (region === null) return;
  event.preventDefault();
  scrollHalfPage(region, direction);
}

/**
 * Whether the last input was a key rather than a pointer. Focus follows a
 * surface change only after a key: a tap that opens a file on the phone must
 * not focus the editor, which would raise the on-screen keyboard.
 */
let lastInputWasKey = false;
const onKeyInput = () => {
  lastInputWasKey = true;
};
const onPointerInput = () => {
  lastInputWasKey = false;
};

/**
 * While a panel is mounted: `enterPanel` is the panel's pane entry, and
 * `Ctrl+D` / `Ctrl+U` scroll its surfaces. When a key changes the active
 * surface while the keyboard is in the panel — `Ctrl+Tab`, a close, a file
 * opened from a tree — focus follows into the new surface; the old one took
 * its focused element with it, which leaves focus on <body>.
 */
export function usePanelSurfaceKeys(
  panelRef: RefObject<Element | null>,
  activeSurfaceId: string | null,
): void {
  useEffect(() => {
    // The empty panel is the launcher, which keeps its own focus.
    if (activeSurfaceId === null || !lastInputWasKey) return;
    const panel = panelRef.current?.closest(PANEL_ROOT_SELECTOR);
    if (!panel) return;
    const active = document.activeElement;
    const inPanel =
      getFocusedPane() === "panel" ||
      ((active === null || active === document.body) && getLastFocusedPane() === "panel");
    if (inPanel) focusPanelSurfaceAfterRender(panel);
  }, [panelRef, activeSurfaceId]);

  useEffect(() => {
    const unregisterEntry = registerPaneEntry("panel", enterPanel);
    window.addEventListener("keydown", onHalfPageKey);
    window.addEventListener("keydown", onKeyInput, true);
    window.addEventListener("pointerdown", onPointerInput, true);
    return () => {
      unregisterEntry();
      window.removeEventListener("keydown", onHalfPageKey);
      window.removeEventListener("keydown", onKeyInput, true);
      window.removeEventListener("pointerdown", onPointerInput, true);
    };
  }, []);
}

let cancelPendingEntry: (() => void) | null = null;

/**
 * After a key changed the panel's active surface: focus its entry once it
 * renders. The panel shows the new tab a frame or more later, so this first
 * waits for the active tab title to differ from `previousTitle` (the title
 * active at the key; null when any title will do). Focus parks on that title,
 * so `Ctrl+Tab` still reads as the panel's, and moves into the surface as soon
 * as its entry appears. A surface that took focus itself (a terminal) keeps it,
 * and a key or a click that moves focus meanwhile wins over the wait.
 */
export function focusPanelSurfaceAfterRender(
  panel: Element,
  previousTitle: Element | null = null,
): void {
  cancelPendingEntry?.();
  let frames = 0;
  let frame = window.requestAnimationFrame(function waitForTab() {
    frame = 0;
    if (!panel.isConnected) return;
    const title = panel.querySelector<HTMLElement>(ACTIVE_TAB_TITLE_SELECTOR);
    // Re-choosing the surface already active never changes the title, so the
    // wait ends with whatever is active then.
    const rendered =
      title !== null && (title !== previousTitle || frames >= ACTIVE_TAB_WAIT_FRAMES);
    if (!rendered) {
      if (++frames <= ACTIVE_TAB_WAIT_FRAMES) frame = window.requestAnimationFrame(waitForTab);
      return;
    }
    const content = panel.querySelector(SURFACE_CONTENT_SELECTOR);
    if (content?.contains(document.activeElement)) return;
    if (focusPanelSurface(panel)) return;
    title.focus({ preventScroll: true });
    waitForEntry(panel, title);
  });
  cancelPendingEntry = () => {
    if (frame !== 0) window.cancelAnimationFrame(frame);
    cancelPendingEntry = null;
  };
}

function waitForEntry(panel: Element, parkedOn: HTMLElement): void {
  const content = panel.querySelector(SURFACE_CONTENT_SELECTOR);
  if (content === null) return;
  let frame = 0;
  const stop = () => {
    observer.disconnect();
    window.clearTimeout(timer);
    document.removeEventListener("focusin", onFocusIn, true);
    if (frame !== 0) window.cancelAnimationFrame(frame);
    if (cancelPendingEntry === stop) cancelPendingEntry = null;
  };
  // Focus went somewhere on its own: the developer moved, or the surface
  // focused itself. The wait ends then, even if focus comes back to the title
  // before the entry renders. A drop to <body> fires no `focusin` and keeps it.
  const onFocusIn = (event: FocusEvent) => {
    if (event.target !== parkedOn) stop();
  };
  const attempt = () => {
    frame = 0;
    const active = document.activeElement;
    if (active !== parkedOn && active !== document.body) return stop();
    if (focusPanelSurface(panel)) stop();
  };
  const observer = new MutationObserver(() => {
    if (frame === 0) frame = window.requestAnimationFrame(attempt);
  });
  observer.observe(content, { childList: true, subtree: true });
  document.addEventListener("focusin", onFocusIn, true);
  const timer = window.setTimeout(stop, ENTRY_WAIT_MS);
  cancelPendingEntry = stop;
}

/** `Ctrl+D` / `Ctrl+U` with no other modifier: half a page down or up. */
export function halfPageDirection(event: KeyboardEvent): "down" | "up" | null {
  if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return null;
  const key = event.key.toLowerCase();
  return key === "d" ? "down" : key === "u" ? "up" : null;
}

/** Scrolls `scroller` half its height, the way `Ctrl+D` / `Ctrl+U` scroll a Vim window. */
export function scrollHalfPage(scroller: HTMLElement, direction: "down" | "up"): void {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  scroller.scrollBy({
    top: ((direction === "down" ? 1 : -1) * scroller.clientHeight) / 2,
    behavior: reduceMotion ? "instant" : "smooth",
  });
}
