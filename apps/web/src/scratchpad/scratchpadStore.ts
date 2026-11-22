import { create } from "zustand";

import { type ScratchpadScope } from "./scratchpadScopes";

interface ScratchpadState {
  readonly open: boolean;
  /** Null until the overlay opens, which picks the scope the open thread starts on. */
  readonly scope: ScratchpadScope | null;
  readonly openScratchpad: (scope?: ScratchpadScope) => void;
  readonly closeScratchpad: () => void;
  readonly toggleScratchpad: () => void;
  readonly setScope: (scope: ScratchpadScope) => void;
}

/** Client-only view state. The notes themselves are files on the host; nothing here persists. */
export const useScratchpadStore = create<ScratchpadState>((set) => ({
  open: false,
  scope: null,
  openScratchpad: (scope) => set({ open: true, scope: scope ?? null }),
  closeScratchpad: () => set({ open: false }),
  toggleScratchpad: () =>
    set((state) => (state.open ? { open: false } : { open: true, scope: null })),
  setScope: (scope) => set({ scope }),
}));
