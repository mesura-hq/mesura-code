import { walkKeys, type KeyNode } from "./keymap.ts";

/**
 * The pending-sequence state machine: keys typed so far, and a count.
 *
 * A prefix persists until the next key resolves it, Escape cancels it, or the
 * host resets it (focus moved, mode changed). It never times out; see
 * `keymap.ts` for why no timeout is needed.
 */

export interface SequenceState {
  readonly pending: readonly string[];
  /** Digits typed before the sequence, as typed. Empty when there is none. */
  readonly count: string;
}

export const IDLE_SEQUENCE: SequenceState = { pending: [], count: "" };

export type SequenceOutcome =
  | { readonly kind: "command"; readonly command: string; readonly count: number | null }
  | { readonly kind: "pending"; readonly node: KeyNode }
  | { readonly kind: "count" }
  | { readonly kind: "cancelled" }
  /** The keys left the trie. The host decides whether to swallow or pass them. */
  | { readonly kind: "unbound"; readonly keys: readonly string[] };

export interface SequenceStep {
  readonly state: SequenceState;
  readonly outcome: SequenceOutcome;
}

function isCountDigit(token: string, state: SequenceState): boolean {
  if (state.pending.length > 0) return false;
  if (token >= "1" && token <= "9") return true;
  return token === "0" && state.count.length > 0;
}

/**
 * Feeds one token. A digit at the root starts or extends a count unless the
 * trie binds that digit itself (Helix rule), so a scope may still bind `0`.
 */
export function stepSequence(trie: KeyNode, state: SequenceState, token: string): SequenceStep {
  if (state.pending.length > 0 || state.count.length > 0) {
    if (token === "<Esc>") return { state: IDLE_SEQUENCE, outcome: { kind: "cancelled" } };
    if (token === "<BS>" && state.pending.length > 0) {
      const pending = state.pending.slice(0, -1);
      const node = walkKeys(trie, pending);
      const next = { ...state, pending };
      return node?.kind === "node" && pending.length > 0
        ? { state: next, outcome: { kind: "pending", node } }
        : { state: next, outcome: { kind: "count" } };
    }
  }

  if (isCountDigit(token, state) && !trie.children.has(token)) {
    return { state: { pending: [], count: state.count + token }, outcome: { kind: "count" } };
  }

  const keys = [...state.pending, token];
  const entry = walkKeys(trie, keys);
  if (entry === undefined) {
    return { state: IDLE_SEQUENCE, outcome: { kind: "unbound", keys } };
  }
  if (entry.kind === "node") {
    return { state: { ...state, pending: keys }, outcome: { kind: "pending", node: entry } };
  }
  const count = state.count.length > 0 ? Number.parseInt(state.count, 10) : null;
  return { state: IDLE_SEQUENCE, outcome: { kind: "command", command: entry.command, count } };
}
