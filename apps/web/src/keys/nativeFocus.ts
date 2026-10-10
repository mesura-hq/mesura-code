/**
 * Focus moves the way it does in a native desktop app: by the app's own keys
 * (the pane moves, the panel launcher, the trees, the sidebar arrows), never
 * by walking the page's tab order. A bare `Tab` or `Shift+Tab` that no element
 * claimed does nothing. The focus outline that walk would show is removed in
 * `mesura.css`. This applies with Vim mode off too, as the focus outlines of
 * round 2 did.
 *
 * Elements that own `Tab` keep it: the terminal, the editor, the composer's
 * menus, the selection toolbar and the thread search each cancel the event
 * themselves. That is why the listener is on the window in the bubble phase,
 * after every element's own handler, and why it cancels only the browser's
 * default action and never stops the event.
 */
let installed = false;

export function installNativeFocus(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("keydown", cancelTabTraversal);
}

/** Cancels the browser's tab-order walk for a `Tab` nothing else claimed. */
function cancelTabTraversal(event: KeyboardEvent): void {
  if (event.key !== "Tab" || event.ctrlKey || event.altKey || event.metaKey) return;
  if (event.defaultPrevented || event.isComposing) return;
  event.preventDefault();
}
