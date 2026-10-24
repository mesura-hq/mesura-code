"use client";

/**
 * Typed window-event bus for the composer and branch-toolbar pickers,
 * following the same shape as `components/preview/previewActionBus.ts`.
 *
 * `traits`, `workspace` and `branch` each own their open state inside a Base UI
 * `Menu` or `Select`. Those triggers open on `mousedown` rather than `click`,
 * so a synthetic click on the button would not reach them, and lifting the
 * state would mean threading it through components upstream rewrites weekly.
 * The bus lets the global keybinding handler in `ChatView` reach them instead.
 *
 * `question` reveals the pending question row in MessagesTimeline. Pending
 * questions stay expanded so they cannot disappear inside a collapsed control.
 *
 * A target that is not currently rendered — a provider with no traits, a
 * workspace control locked once the thread owns a worktree, a thread with no
 * question waiting — must not subscribe. Otherwise a press while it is hidden
 * still flips its state and it opens by itself once the target returns.
 *
 * "Picker" in the exported names is historical: every target was one when the
 * bus was written. Read it as "a chat control a keybinding has to reach".
 *
 * The `runContext.*` actions reach the run context drawer in BranchToolbar,
 * which owns the machine and workspace handlers the quick toggles call.
 */
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
