import { useEffect, useLayoutEffect, useState } from "react";

/**
 * The sidebar thread list as the screen shows it, read from the DOM.
 *
 * `Sidebar.tsx` marks each thread row with `data-mesura-thread-key`; this
 * module measures those rows against the list's scroll viewport. It is how
 * `Ctrl+1..9` number the threads on screen rather than the first nine of the
 * list (ADR-009, decision 8), and how `Ctrl+D` / `Ctrl+U` scroll the list
 * without opening a thread (#79).
 */

const THREAD_ROW_SELECTOR = "[data-mesura-thread-key]";
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
    document.querySelector(THREAD_ROW_SELECTOR)?.closest<HTMLElement>(SCROLL_VIEWPORT_SELECTOR) ??
    null
  );
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
  // Rows measured now, moved to where they will be when a pending scroll stops.
  const shift = pendingScroll?.scroller === scroller ? pendingScroll.top - scroller.scrollTop : 0;
  const rows: { key: string; top: number }[] = [];
  for (const row of scroller.querySelectorAll<HTMLElement>(THREAD_ROW_SELECTOR)) {
    const rect = row.getBoundingClientRect();
    const middle = rect.top - shift + rect.height / 2;
    if (rect.height === 0 || middle < bounds.top || middle > bounds.bottom) continue;
    rows.push({ key: row.dataset.mesuraThreadKey ?? "", top: rect.top });
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
 * The thread keys on screen while `active` (the jump hints show), read again
 * at most once a frame while the list scrolls, so the numbers follow a
 * `Ctrl+D` made with `Ctrl` still held. Null while inactive or off screen.
 */
export function useViewportThreadKeys(active: boolean): readonly string[] | null {
  const [keys, setKeys] = useState<readonly string[] | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    const scroller = threadListScroller();
    let frame = 0;
    const read = () => {
      frame = 0;
      const next = readViewportThreadKeys();
      setKeys((previous) => (sameKeys(previous, next) ? previous : next));
    };
    const onScroll = () => {
      if (frame === 0) frame = window.requestAnimationFrame(read);
    };
    read();
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

/**
 * Up and Down move the keyboard focus over the thread rows, which shows a
 * row's hover tint and its details tooltip without opening the thread; Enter
 * opens it. Only while focus is in the thread list.
 */
export function useThreadRowArrowKeys(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.shiftKey) return;
      const scroller = threadListScroller();
      const active = document.activeElement;
      if (scroller === null || !(active instanceof HTMLElement) || !scroller.contains(active)) {
        return;
      }
      // A row's own controls (rename field, menus) keep their arrows.
      const current = active.closest<HTMLElement>(THREAD_ROW_SELECTOR);
      if (current !== null && current !== active) return;
      event.preventDefault();
      const rows = [...scroller.querySelectorAll<HTMLElement>(THREAD_ROW_SELECTOR)];
      const index = current === null ? -1 : rows.indexOf(current);
      const next =
        event.key === "ArrowDown" ? rows[index + 1] : index === -1 ? rows.at(-1) : rows[index - 1];
      if (next === undefined) return;
      next.focus({ preventScroll: true });
      next.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
