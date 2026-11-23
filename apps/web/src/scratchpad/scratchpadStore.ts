import { type ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import { type DraftId } from "~/composerDraftStore";

import { type ScratchpadScope } from "./scratchpadScopes";

/**
 * `closing` keeps the overlay mounted, hidden and without focus, until the keys already sent to
 * Neovim are answered and the save is written: unmounting at once lost the last keys.
 */
type ScratchpadPhase = "closed" | "open" | "closing";

interface ScratchpadState {
  readonly phase: ScratchpadPhase;
  /** Null until the overlay opens, which picks the scope the open thread starts on. */
  readonly scope: ScratchpadScope | null;
  /**
   * Bumped by every open, and the overlay is keyed by it: each open mounts afresh, so it reads the
   * host and asks Neovim for normal mode again, even right after a close that is still settling.
   */
  readonly openCount: number;
  /** The chat view (environment and thread) an open belongs to; no other view mounts it. */
  readonly owner: string | null;
  /** Bumped when an abandoned note's save lands, so the preview card reads it again. */
  readonly savedRevision: number;
  readonly noteSaved: () => void;
  /** An open asked for while a close settles; it happens once the close finishes. */
  readonly reopen: { readonly scope: ScratchpadScope | null; readonly owner: string } | null;
  readonly openScratchpad: (owner: string, scope?: ScratchpadScope) => void;
  readonly closeScratchpad: () => void;
  readonly finishClosing: () => void;
  readonly toggleScratchpad: (owner: string) => void;
  /** The owning view went away without its close: nothing else may take the open over. */
  readonly abandonScratchpad: (owner: string) => void;
  /** A reopen asked for by a view that has since moved on (another thread) is dropped. */
  readonly dropReopenUnless: (owner: string) => void;
  readonly setScope: (scope: ScratchpadScope) => void;
}

const opened = (state: ScratchpadState, owner: string, scope: ScratchpadScope | null) =>
  state.phase === "closing"
    ? { reopen: { scope, owner } }
    : { phase: "open" as const, scope, owner, openCount: state.openCount + 1 };

/** Client-only view state. The notes themselves are files on the host; nothing here persists. */
export const useScratchpadStore = create<ScratchpadState>((set) => ({
  phase: "closed",
  scope: null,
  openCount: 0,
  owner: null,
  savedRevision: 0,
  noteSaved: () => set((state) => ({ savedRevision: state.savedRevision + 1 })),
  reopen: null,
  openScratchpad: (owner, scope) =>
    set((state) =>
      state.phase === "open" && state.owner === owner
        ? { scope: scope ?? null }
        : state.phase === "open"
          ? {}
          : opened(state, owner, scope ?? null),
    ),
  closeScratchpad: () => set((state) => (state.phase === "open" ? { phase: "closing" } : {})),
  finishClosing: () =>
    set((state) => {
      if (state.phase !== "closing") return {};
      if (state.reopen === null) return { phase: "closed", owner: null };
      return {
        phase: "open",
        scope: state.reopen.scope,
        owner: state.reopen.owner,
        reopen: null,
        openCount: state.openCount + 1,
      };
    }),
  toggleScratchpad: (owner) =>
    set((state) => {
      if (state.phase === "open") return { phase: "closing" };
      // A second toggle while a reopen waits cancels it, as a second press of the chord means.
      if (state.phase === "closing" && state.reopen !== null) return { reopen: null };
      return opened(state, owner, null);
    }),
  abandonScratchpad: (owner) =>
    set((state) =>
      state.owner === owner && state.phase !== "closed"
        ? { phase: "closed", owner: null, reopen: null }
        : {},
    ),
  dropReopenUnless: (owner) =>
    set((state) => (state.reopen !== null && state.reopen.owner !== owner ? { reopen: null } : {})),
  setScope: (scope) => set({ scope }),
}));

/** Names the chat view an open belongs to: its composer target is unique per view. */
export function scratchpadOwnerKey(target: ScopedThreadRef | DraftId): string {
  return typeof target === "string"
    ? `draft:${target}`
    : `${target.environmentId}:${target.threadId}`;
}
