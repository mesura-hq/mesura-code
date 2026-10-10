import { useSyncExternalStore } from "react";

/**
 * The expanded composer: half the window high, with a line-number gutter, so
 * a long prompt reads and edits like a buffer. A toggle for the session, not
 * a setting. The height lives in `mesura.css` under
 * `[data-mesura-composer-expanded]`; the gutter is `ComposerLineNumbers`.
 *
 * `bumpComposerLayout` marks that the composer's text or cursor may have
 * moved, so the gutter re-measures only then, never on a timer.
 */

let expanded = false;
let layoutVersion = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function toggleComposerExpanded(): void {
  expanded = !expanded;
  if (expanded) document.documentElement.dataset.mesuraComposerExpanded = "";
  else delete document.documentElement.dataset.mesuraComposerExpanded;
  emit();
}

export function collapseComposer(): void {
  if (expanded) toggleComposerExpanded();
}

export function bumpComposerLayout(): void {
  layoutVersion += 1;
  emit();
}

export function useComposerExpanded(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => expanded,
    () => false,
  );
}

/** Calls `listener` whenever the composer's text or cursor may have moved. */
export function subscribeComposerLayout(listener: () => void): () => void {
  let seen = layoutVersion;
  return subscribe(() => {
    if (layoutVersion === seen) return;
    seen = layoutVersion;
    listener();
  });
}
