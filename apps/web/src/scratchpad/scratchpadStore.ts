import { create } from "zustand";

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
  /** An open asked for while a close settles; it happens once the close finishes. */
  readonly reopen: { readonly scope: ScratchpadScope | null } | null;
  readonly openScratchpad: (scope?: ScratchpadScope) => void;
  readonly closeScratchpad: () => void;
  readonly finishClosing: () => void;
  readonly toggleScratchpad: () => void;
  readonly setScope: (scope: ScratchpadScope) => void;
}

const opened = (state: ScratchpadState, scope: ScratchpadScope | null) =>
  state.phase === "closing"
    ? { reopen: { scope } }
    : { phase: "open" as const, scope, openCount: state.openCount + 1 };

/** Client-only view state. The notes themselves are files on the host; nothing here persists. */
export const useScratchpadStore = create<ScratchpadState>((set) => ({
  phase: "closed",
  scope: null,
  openCount: 0,
  reopen: null,
  openScratchpad: (scope) =>
    set((state) =>
      state.phase === "open" ? { scope: scope ?? null } : opened(state, scope ?? null),
    ),
  closeScratchpad: () => set((state) => (state.phase === "open" ? { phase: "closing" } : {})),
  finishClosing: () =>
    set((state) => {
      if (state.phase !== "closing") return {};
      if (state.reopen === null) return { phase: "closed" };
      return {
        phase: "open",
        scope: state.reopen.scope,
        reopen: null,
        openCount: state.openCount + 1,
      };
    }),
  toggleScratchpad: () =>
    set((state) => {
      if (state.phase === "open") return { phase: "closing" };
      // A second toggle while a reopen waits cancels it, as a second press of the chord means.
      if (state.phase === "closing" && state.reopen !== null) return { reopen: null };
      return opened(state, null);
    }),
  setScope: (scope) => set({ scope }),
}));
