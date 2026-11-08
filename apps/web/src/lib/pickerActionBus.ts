"use client";

// The Base UI triggers of `traits`, `workspace` and `branch` open on `mousedown`, so
// a synthetic click misses them and lifting their state touches upstream-churned
// components; the bus lets `ChatView`'s keybindings reach them. A target not
// rendered must not subscribe, or a press while hidden opens it once it returns.
export type PickerAction =
  | "traits"
  | "workspace"
  | "branch"
  | "question"
  | "runContext.toggle"
  | "runContext.cycleMachine"
  | "runContext.toggleWorkspace";

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
