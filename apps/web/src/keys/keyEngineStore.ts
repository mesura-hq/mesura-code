import { useSyncExternalStore } from "react";
import type { WhichKeyRow } from "@mesura/keys/keymap";

/**
 * What the key engine shows: the mode indicator, the pending keys and the
 * which-key popup. Kept outside React so the window listener can update it
 * without a render on every key; components read it through
 * `useKeyEngineSnapshot`.
 */

export type EngineModeLabel = "NORMAL" | "INSERT" | "VISUAL" | "V-LINE" | "FLASH" | "PANE";

export interface KeyEngineSnapshot {
  readonly enabled: boolean;
  readonly mode: EngineModeLabel;
  /** Where the keys go: `chat`, `composer`, `sidebar`, `panel`, `terminal`. */
  readonly scope: string;
  readonly pending: readonly string[];
  readonly whichKey: { readonly title: string; readonly rows: readonly WhichKeyRow[] } | null;
  /** A short notice, such as an unbound sequence. Cleared by the next key. */
  readonly notice: string | null;
}

let snapshot: KeyEngineSnapshot = {
  enabled: false,
  mode: "NORMAL",
  scope: "chat",
  pending: [],
  whichKey: null,
  notice: null,
};
const listeners = new Set<() => void>();

export function readKeyEngineSnapshot(): KeyEngineSnapshot {
  return snapshot;
}

export function updateKeyEngineSnapshot(patch: Partial<KeyEngineSnapshot>): void {
  let changed = false;
  for (const key of Object.keys(patch) as (keyof KeyEngineSnapshot)[]) {
    if (snapshot[key] !== patch[key]) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useKeyEngineSnapshot(): KeyEngineSnapshot {
  return useSyncExternalStore(subscribe, readKeyEngineSnapshot, readKeyEngineSnapshot);
}
