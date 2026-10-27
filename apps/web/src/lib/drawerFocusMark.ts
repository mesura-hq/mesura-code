// Mirrors "focus is inside the terminal drawer" onto `<html>` for the pane mark
// in `mesura.css`: the drawer sits inside the chat column, so CSS would need an
// unaffordable `:has()`. Written to the DOM only when the answer changes, so focus
// moves re-render nothing.

import { TERMINAL_DRAWER_SELECTOR } from "./paneFocus";

export const DRAWER_FOCUS_MARK_ATTRIBUTE = "data-mesura-drawer-focused";

interface FocusEventLike {
  readonly target: unknown;
  readonly relatedTarget: unknown;
}

interface MarkRoot {
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export interface FocusEventSource {
  addEventListener(type: string, listener: (event: never) => void, capture: boolean): void;
  removeEventListener(type: string, listener: (event: never) => void, capture: boolean): void;
}

// Structural rather than `instanceof Element`, so the node test harness can
// pass plain objects; a focus target without `closest` is never in the drawer.
function isInsideDrawer(node: unknown): boolean {
  const closest = (node as { closest?: (selector: string) => unknown } | null)?.closest;
  return typeof closest === "function" && closest.call(node, TERMINAL_DRAWER_SELECTOR) != null;
}

function applyMark(root: MarkRoot, drawerFocused: boolean): void {
  if (root.hasAttribute(DRAWER_FOCUS_MARK_ATTRIBUTE) === drawerFocused) return;
  if (drawerFocused) root.setAttribute(DRAWER_FOCUS_MARK_ATTRIBUTE, "");
  else root.removeAttribute(DRAWER_FOCUS_MARK_ATTRIBUTE);
}

// Starts from the focused element, so a remount keeps the mark. `focusout` reads
// `relatedTarget` so leaving the drawer clears it in the same event. A drawer that
// unmounts with focus fires nothing; the composer's `focusin` clears it then.
export function registerDrawerFocusMark(input: {
  readonly document: FocusEventSource;
  readonly root: MarkRoot;
  readonly getActiveElement: () => unknown;
}): () => void {
  const onFocusIn = (event: FocusEventLike) => applyMark(input.root, isInsideDrawer(event.target));
  const onFocusOut = (event: FocusEventLike) =>
    applyMark(input.root, isInsideDrawer(event.relatedTarget));

  input.document.addEventListener("focusin", onFocusIn as (event: never) => void, true);
  input.document.addEventListener("focusout", onFocusOut as (event: never) => void, true);
  applyMark(input.root, isInsideDrawer(input.getActiveElement()));
  return () => {
    input.document.removeEventListener("focusin", onFocusIn as (event: never) => void, true);
    input.document.removeEventListener("focusout", onFocusOut as (event: never) => void, true);
    input.root.removeAttribute(DRAWER_FOCUS_MARK_ATTRIBUTE);
  };
}
