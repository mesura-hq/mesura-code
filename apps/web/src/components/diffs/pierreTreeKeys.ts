import type { FileTree } from "@pierre/trees";
import { useCallback, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { halfPageDirection, setPaneEntryFocus } from "~/lib/panelSurfaceFocus";

/**
 * Fork addition: the keyboard way into a Pierre file tree (the Diff surface's
 * file list and Tree diff), and `Ctrl+D` / `Ctrl+U` in it.
 *
 * Pierre renders its rows in a shadow root and moves a roving `tabindex="0"`
 * over them; its own keys cover the arrows, Home and End, and a row is a
 * button, so Enter opens it. Focusing the tree means focusing that row, which
 * a selector from the page cannot reach. Pierre has no half-page move, so
 * `Ctrl+D` / `Ctrl+U` scroll its viewport half a page and focus the row that
 * scrolled to where the focused one was, as Vim moves the cursor with the text.
 */

const ROW_SELECTOR = "button[data-item-path]:not([data-file-tree-sticky-row])";
const SCROLLER_SELECTOR = "[data-file-tree-virtualized-scroll]";

function shadowRootOf(model: FileTree): ShadowRoot | null {
  return model.getFileTreeContainer()?.shadowRoot ?? null;
}

function focusedRow(root: ShadowRoot): HTMLElement | null {
  return (
    root.querySelector<HTMLElement>(`${ROW_SELECTOR}[tabindex="0"]`) ??
    root.querySelector<HTMLElement>(ROW_SELECTOR)
  );
}

/** Focuses the tree's current row, else its first; false when it shows none. */
export function focusPierreTree(model: FileTree): boolean {
  const root = shadowRootOf(model);
  const row = root ? focusedRow(root) : null;
  if (row === null) return false;
  row.focus({ preventScroll: true });
  return root?.activeElement === row;
}

/** The mounted rows, top to bottom. */
function rowsInOrder(root: ShadowRoot): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(ROW_SELECTOR)].toSorted(
    (left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top,
  );
}

function clampedRow(rows: readonly HTMLElement[], index: number): HTMLElement | null {
  return rows[Math.max(0, Math.min(rows.length - 1, index))] ?? null;
}

function moveHalfPage(model: FileTree, direction: "down" | "up"): void {
  const root = shadowRootOf(model);
  const scroller = root?.querySelector<HTMLElement>(SCROLLER_SELECTOR);
  const from = root ? focusedRow(root) : null;
  if (!root || !scroller || !from) return;
  const box = from.getBoundingClientRect();
  const offset = box.top + box.height / 2 - scroller.getBoundingClientRect().top;
  const sign = direction === "down" ? 1 : -1;
  const before = scroller.scrollTop;
  scroller.scrollTop += (sign * scroller.clientHeight) / 2;
  if (scroller.scrollTop === before) {
    // Nothing left to scroll: the focus moves half a page of rows, as Vim's
    // cursor does at the end of a buffer.
    const rows = rowsInOrder(root);
    const step = Math.max(1, Math.round(scroller.clientHeight / 2 / Math.max(1, box.height)));
    clampedRow(rows, rows.indexOf(from) + sign * step)?.focus({ preventScroll: true });
    return;
  }
  // Pierre mounts the rows for the new position on its scroll event, a frame
  // later; the row now where the focused one was takes the focus.
  window.requestAnimationFrame(() =>
    window.requestAnimationFrame(() => {
      const y = scroller.getBoundingClientRect().top + offset;
      const rows = rowsInOrder(root);
      const hit = rows.find((row) => {
        const rowBox = row.getBoundingClientRect();
        return rowBox.top <= y && y < rowBox.bottom;
      });
      (hit ?? clampedRow(rows, direction === "down" ? rows.length - 1 : 0))?.focus({
        preventScroll: true,
      });
    }),
  );
}

/**
 * The tree wrapper's ref callback and key handler: `bind` makes it the panel's
 * entry (`panelSurfaceFocus.ts`), `onKeyDown` adds the half-page moves.
 */
export function usePierreTreePaneEntry(model: FileTree) {
  const bind = useCallback(
    (element: HTMLElement | null) =>
      element ? setPaneEntryFocus(element, () => focusPierreTree(model)) : undefined,
    [model],
  );
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      const direction = halfPageDirection(event.nativeEvent);
      if (direction === null || event.defaultPrevented) return;
      if (!shadowRootOf(model)?.activeElement) return;
      event.preventDefault();
      moveHalfPage(model, direction);
    },
    [model],
  );
  return { bind, onKeyDown };
}
