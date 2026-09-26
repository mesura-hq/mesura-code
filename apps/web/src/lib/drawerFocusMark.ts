/**
 * Mirrors "focus is inside the terminal drawer" onto `<html>`, for the pane
 * mark in `mesura.css`.
 *
 * The mark hands the chat column's hairline to the drawer while focus is in
 * the drawer. The drawer renders inside the chat column and after its header,
 * so CSS can only ask that question with `:has()` on the chat column — and
 * that is not affordable here. See the "Which pane has the keyboard" block in
 * `mesura.css` for the measurement.
 *
 * The attribute is written straight to the DOM, never through React state, so
 * no component re-renders when focus moves. It is written only when the answer
 * changes, so focus moving between two elements on the same side of the drawer
 * boundary invalidates nothing.
 */

export const DRAWER_FOCUS_MARK_ATTRIBUTE = "data-mesura-drawer-focused";

const DRAWER_SELECTOR = '[data-terminal-owner="drawer"]';

interface FocusEventLike {
  readonly target: unknown;
  readonly relatedTarget: unknown;
}

interface MarkRoot {
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

interface FocusEventSource {
  addEventListener(type: string, listener: (event: never) => void, capture: boolean): void;
  removeEventListener(type: string, listener: (event: never) => void, capture: boolean): void;
}

function isInsideDrawer(node: unknown): boolean {
  const closest = (node as { closest?: (selector: string) => unknown } | null)?.closest;
  return typeof closest === "function" && closest.call(node, DRAWER_SELECTOR) != null;
}

function applyMark(root: MarkRoot, drawerFocused: boolean): void {
  if (root.hasAttribute(DRAWER_FOCUS_MARK_ATTRIBUTE) === drawerFocused) return;
  if (drawerFocused) root.setAttribute(DRAWER_FOCUS_MARK_ATTRIBUTE, "");
  else root.removeAttribute(DRAWER_FOCUS_MARK_ATTRIBUTE);
}

/**
 * Keeps the mark in step with focus until the returned cleanup runs.
 *
 * `focusout` reads `relatedTarget`, the element about to receive focus, so a
 * move from the drawer to anywhere else clears the mark in the same event.
 * A drawer that unmounts while it holds focus fires no event; the composer
 * takes focus back when the drawer closes, and that `focusin` clears it.
 */
export function registerDrawerFocusMark(input: {
  readonly document: FocusEventSource;
  readonly root: MarkRoot;
}): () => void {
  const onFocusIn = (event: FocusEventLike) => applyMark(input.root, isInsideDrawer(event.target));
  const onFocusOut = (event: FocusEventLike) =>
    applyMark(input.root, isInsideDrawer(event.relatedTarget));

  input.document.addEventListener("focusin", onFocusIn as (event: never) => void, true);
  input.document.addEventListener("focusout", onFocusOut as (event: never) => void, true);
  return () => {
    input.document.removeEventListener("focusin", onFocusIn as (event: never) => void, true);
    input.document.removeEventListener("focusout", onFocusOut as (event: never) => void, true);
    input.root.removeAttribute(DRAWER_FOCUS_MARK_ATTRIBUTE);
  };
}
