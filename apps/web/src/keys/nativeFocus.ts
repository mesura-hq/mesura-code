/**
 * Focus moves only by the app's own keys, never the tab order, with Vim mode off too: an unclaimed
 * bare `Tab` does nothing. Elements that own `Tab` (terminal, editor, composer menus) cancel it
 * themselves, so the listener sits on the window in the bubble phase, after them, and only
 * prevents the default; it never stops the event.
 */
let installed = false;

export function installNativeFocus(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("keydown", cancelTabWhereItStops, true);
  window.addEventListener("keydown", cancelTabTraversal);
}

function isBareTab(event: KeyboardEvent): boolean {
  return event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey;
}

/** Cancels the browser's tab-order walk for a `Tab` nothing else claimed. */
function cancelTabTraversal(event: KeyboardEvent): void {
  if (!isBareTab(event) || event.defaultPrevented || event.isComposing) return;
  event.preventDefault();
}

/**
 * WORKAROUND: a handler that stops a `Tab` without cancelling it (`RightPanelTabs.tsx`'s rename
 * field, Monaco comment zones) hides it from the window listener; wrapping this event's stop methods
 * cancels the walk there without editing each upstream handler. Remove if the platform can observe
 * a stopped event, or if the tab walk is wanted back.
 */
function cancelTabWhereItStops(event: KeyboardEvent): void {
  if (!isBareTab(event)) return;
  const stopPropagation = event.stopPropagation.bind(event);
  const stopImmediatePropagation = event.stopImmediatePropagation.bind(event);
  event.stopPropagation = () => {
    stopPropagation();
    cancelTabTraversal(event);
  };
  event.stopImmediatePropagation = () => {
    stopImmediatePropagation();
    cancelTabTraversal(event);
  };
}
