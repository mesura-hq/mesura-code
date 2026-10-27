import { useEffect, useLayoutEffect, useState, type Dispatch, type SetStateAction } from "react";

/**
 * Measures the rows `Sidebar.tsx` marks with `data-mesura-thread-key` against the list's
 * scroll viewport, so `Ctrl+1..9` number the threads on screen rather than the first nine
 * of the list (ADR-009, decision 8).
 */

const THREAD_ROW_SELECTOR = "[data-mesura-thread-key]";
/** What Up and Down walk: the rows, and section headers such as Working's. */
const NAV_STOP_SELECTOR = "[data-mesura-thread-key], [data-mesura-nav-stop]";
/** The sidebar's Search field; Down from it, while empty, enters the list. */
const THREAD_SEARCH_SELECTOR = "[data-mesura-thread-search]";
const SCROLL_VIEWPORT_SELECTOR = '[data-slot="scroll-area-viewport"]';

/**
 * Where a `Ctrl+D` / `Ctrl+U` scroll will stop, while it animates. The numbers
 * are read for that position, so they show the destination's rows from the
 * key press on, the same way down and up, and a number typed mid-scroll opens
 * the row it shows. Cleared when the scroll settles.
 */
let pendingScroll: { readonly scroller: HTMLElement; readonly top: number } | null = null;
/** A smooth scroll that never reports `scrollend` must not hold the target forever. */
const SCROLL_SETTLE_TIMEOUT_MS = 800;
/** Tells the numbers a scroll target was set, before the first scroll frame. */
const PENDING_SCROLL_EVENT = "mesura:thread-list-scroll-target";

function threadListScroller(): HTMLElement | null {
  return (
    document.querySelector(NAV_STOP_SELECTOR)?.closest<HTMLElement>(SCROLL_VIEWPORT_SELECTOR) ??
    null
  );
}

/**
 * The thread rows in the list, without the inert copy the list's motion
 * (`Sidebar.motion.ts`) keeps of a removed row while it fades out.
 */
function threadRows(scroller: HTMLElement): HTMLElement[] {
  return [...scroller.querySelectorAll<HTMLElement>(THREAD_ROW_SELECTOR)].filter(
    (row) => row.closest("[inert]") === null,
  );
}

/**
 * A row's top in the list's scroll content, from layout offsets. Its client
 * rect includes the transform the list's reorder animation runs, which for
 * 150ms still draws a moved row where it was; the offsets give where the
 * commit put it.
 */
function contentTop(row: HTMLElement, scroller: HTMLElement): number {
  let top = 0;
  let element = row;
  for (;;) {
    const parent = element.offsetParent;
    if (parent === scroller) return top + element.offsetTop;
    if (!(parent instanceof HTMLElement) || !scroller.contains(parent)) {
      // The offsets leave the list at `element`, an ancestor the motion does
      // not move, so its box is where layout put it.
      const box = element.getBoundingClientRect().top;
      const origin = scroller.getBoundingClientRect().top + scroller.clientTop;
      return top + box - origin + scroller.scrollTop;
    }
    top += element.offsetTop;
    element = parent;
  }
}

/**
 * The thread keys of the rows on screen, top to bottom: a row counts when its
 * middle is inside the list's viewport. Null when the list is not on screen
 * (the sidebar collapsed or closed), so a caller can fall back to the list's
 * own order.
 */
export function readViewportThreadKeys(): string[] | null {
  const scroller = threadListScroller();
  if (scroller === null) return null;
  const bounds = scroller.getBoundingClientRect();
  if (bounds.width === 0 || bounds.height === 0) return null;
  // The viewport where a pending scroll will stop, or where it is now.
  const viewportTop = pendingScroll?.scroller === scroller ? pendingScroll.top : scroller.scrollTop;
  const viewportBottom = viewportTop + scroller.clientHeight;
  const rows: { key: string; top: number }[] = [];
  for (const row of threadRows(scroller)) {
    const height = row.offsetHeight;
    if (height === 0) continue;
    const top = contentTop(row, scroller);
    const middle = top + height / 2;
    if (middle < viewportTop || middle > viewportBottom) continue;
    rows.push({ key: row.dataset.mesuraThreadKey ?? "", top });
  }
  return rows.toSorted((left, right) => left.top - right.top).map((row) => row.key);
}

/**
 * Scrolls the thread list half its height, the way `Ctrl+D` and `Ctrl+U`
 * scroll a Vim window; focus and the open thread stay where they are. False
 * when the list is not on screen.
 */
export function scrollThreadList(direction: "up" | "down"): boolean {
  const scroller = threadListScroller();
  if (scroller === null || scroller.clientHeight === 0) return false;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const from = pendingScroll?.scroller === scroller ? pendingScroll.top : scroller.scrollTop;
  const top = Math.max(
    0,
    Math.min(
      scroller.scrollHeight - scroller.clientHeight,
      from + ((direction === "down" ? 1 : -1) * scroller.clientHeight) / 2,
    ),
  );
  settlePendingScroll(scroller, top);
  scroller.scrollTo({ top, behavior: reduceMotion ? "instant" : "smooth" });
  // The numbers move to the destination now, not at the first scroll frame.
  scroller.dispatchEvent(new Event(PENDING_SCROLL_EVENT));
  return true;
}

function settlePendingScroll(scroller: HTMLElement, top: number): void {
  const pending = { scroller, top };
  pendingScroll = pending;
  const finish = () => {
    scroller.removeEventListener("scrollend", finish);
    window.clearTimeout(timer);
    if (pendingScroll === pending) pendingScroll = null;
  };
  const timer = window.setTimeout(finish, SCROLL_SETTLE_TIMEOUT_MS);
  scroller.addEventListener("scrollend", finish);
}

const sameKeys = (left: readonly string[] | null, right: readonly string[] | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.length === right.length &&
    left.every((key, index) => key === right[index]));

/**
 * Read after every commit, because a reorder or an added or removed thread moves rows
 * without a scroll. A layout effect, so a changed list renders again before paint. Also
 * read once a frame while the list scrolls, so the numbers follow a held `Ctrl+D`.
 */
export function useViewportThreadKeys(active: boolean): readonly string[] | null {
  const [keys, setKeys] = useState<readonly string[] | null>(null);
  // No dependency list on purpose; compares with this render's `keys`. A functional update
  // here queued a no-op update per commit and hit "Maximum update depth exceeded".
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: measures the committed DOM after every commit, which render cannot read
  useLayoutEffect(() => {
    if (!active) return;
    const next = readViewportThreadKeys();
    // oxlint-disable-next-line react/set-state-in-effect -- The rows on screen come from measuring the committed DOM, which render cannot read.
    if (!sameKeys(keys, next)) setKeys(next);
  });
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: subscribes to the thread list's scroll events while the jump hints show
  useLayoutEffect(() => {
    if (!active) return;
    const scroller = threadListScroller();
    let frame = 0;
    const read = () => refreshViewportThreadKeys(setKeys);
    const onScroll = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        read();
      });
    };
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    scroller?.addEventListener(PENDING_SCROLL_EVENT, read);
    return () => {
      scroller?.removeEventListener("scroll", onScroll);
      scroller?.removeEventListener(PENDING_SCROLL_EVENT, read);
      window.cancelAnimationFrame(frame);
    };
  }, [active]);
  return active ? keys : null;
}

function refreshViewportThreadKeys(
  setKeys: Dispatch<SetStateAction<readonly string[] | null>>,
): void {
  const next = readViewportThreadKeys();
  setKeys((previous) => (sameKeys(previous, next) ? previous : next));
}

function navStops(scroller: HTMLElement): HTMLElement[] {
  return [...scroller.querySelectorAll<HTMLElement>(NAV_STOP_SELECTOR)].filter(
    (stop) => stop.closest("[inert]") === null,
  );
}

export function moveThreadListFocus(key: "ArrowDown" | "ArrowUp"): boolean {
  const scroller = threadListScroller();
  const active = document.activeElement;
  if (scroller === null || !(active instanceof HTMLElement)) return false;
  const fromEmptySearch =
    key === "ArrowDown" &&
    active instanceof HTMLInputElement &&
    active.matches(THREAD_SEARCH_SELECTOR) &&
    active.value === "";
  if (!fromEmptySearch && !scroller.contains(active)) return false;
  // A row's own controls (rename field, menus) keep their arrows.
  const current = fromEmptySearch ? null : active.closest<HTMLElement>(NAV_STOP_SELECTOR);
  if (current !== null && current !== active) return false;
  const rows = navStops(scroller);
  const index = current === null ? -1 : rows.indexOf(current);
  // Up from the top stop returns to Search, the way Down came in.
  const next =
    key === "ArrowDown"
      ? rows[index + 1]
      : index === -1
        ? rows.at(-1)
        : index === 0
          ? document.querySelector<HTMLElement>(THREAD_SEARCH_SELECTOR)
          : rows[index - 1];
  if (next === undefined || next === null) return true;
  next.focus({ preventScroll: true });
  next.scrollIntoView({ block: "nearest" });
  return true;
}

/**
 * Up and Down move the keyboard focus over the thread rows and section
 * headers, which shows a row's hover tint and its details tooltip without
 * opening the thread; Enter opens it. Only while focus is in the thread list,
 * or Down in the empty Search field, which enters the list at its top.
 */
export function useThreadRowArrowKeys(): void {
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: window keydown listener for thread-row arrow navigation, removed on unmount
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.shiftKey) return;
      if (moveThreadListFocus(event.key)) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
