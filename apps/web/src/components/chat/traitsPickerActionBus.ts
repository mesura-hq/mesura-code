"use client";

/**
 * Typed window-event bus for the composer traits picker, following the same
 * shape as `preview/previewActionBus.ts`.
 *
 * The picker owns its own open state inside a Base UI `Menu`, and that trigger
 * opens on `mousedown` rather than `click`, so a synthetic click on the button
 * would not reach it. The bus lets the global keybinding handler in `ChatView`
 * toggle the menu without lifting that state through `ChatComposer`.
 *
 * Only the composer's picker subscribes. The same component also renders
 * inside settings panels, and those must not react to a chat shortcut.
 */
const EVENT_NAME = "t3code:traits-picker-toggle";

export function dispatchTraitsPickerToggle(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT_NAME));
}

export function subscribeTraitsPickerToggle(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => listener();
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
