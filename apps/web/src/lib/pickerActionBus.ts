"use client";

/**
 * Typed window-event bus for the composer and branch-toolbar pickers,
 * following the same shape as `components/preview/previewActionBus.ts`.
 *
 * Each of these pickers owns its open state inside a Base UI `Menu` or
 * `Select`. Those triggers open on `mousedown` rather than `click`, so a
 * synthetic click on the button would not reach them, and lifting the state
 * would mean threading it through components upstream rewrites weekly. The bus
 * lets the global keybinding handler in `ChatView` reach them instead.
 *
 * A picker that is not currently rendered — a provider with no traits, a
 * workspace control locked once the thread owns a worktree — must not
 * subscribe. Otherwise a press while it is hidden still flips its state and
 * the menu opens by itself once the picker returns.
 */
export type PickerAction = "traits" | "workspace" | "branch";

const EVENT_NAME = "t3code:picker-action";

export function dispatchPickerAction(action: PickerAction): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<PickerAction>(EVENT_NAME, { detail: action }));
}

export function subscribePickerAction(action: PickerAction, listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    if ((event as CustomEvent<PickerAction>).detail === action) listener();
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
