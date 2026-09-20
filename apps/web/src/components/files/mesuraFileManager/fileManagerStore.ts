import { create } from "zustand";

interface FileManagerState {
  /** The file manager's Miller view is up over the window. Session state, never stored. */
  readonly open: boolean;
  setOpen(open: boolean): void;
  toggle(): void;
}

/**
 * Whether the layer is up: the chord, the tree's Miller button and the
 * bridge's `hideWindow` all write it. Its own store rather than a flag on the
 * tree's: the layer covers the whole window and does not belong to the files
 * surface, and the tree's overview flag it would sit beside is being retired
 * in favour of the file manager's own overview.
 */
export function createFileManagerStore() {
  return create<FileManagerState>((set, get) => ({
    open: false,
    setOpen: (open) => {
      if (get().open === open) return;
      set({ open });
    },
    toggle: () => get().setOpen(!get().open),
  }));
}

export const useFileManagerStore = createFileManagerStore();
