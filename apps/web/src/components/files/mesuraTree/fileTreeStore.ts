import * as Schema from "effect/Schema";
import { create } from "zustand";

import { createSchemaLocalStorage } from "./schemaLocalStorage";

/** The T3 tree's key, kept so an existing preference carries over. */
export const EXPLORER_OPEN_STORAGE_KEY = "t3code.fileExplorerOpen";

export interface ExplorerOpenStorage {
  read(): boolean | null;
  write(open: boolean): void;
}

interface FileTreeState {
  /** The tree pane of the files surface is shown beside the file. */
  readonly explorerOpen: boolean;
  /** A focus was requested before the tree mounted; the tree takes it on mount. */
  readonly pendingFocus: boolean;
  /** The folder overview graph is open over the window. Session state, never stored. */
  readonly overviewOpen: boolean;
  setExplorerOpen(open: boolean): void;
  toggleExplorer(): void;
  requestFocus(): void;
  /** A resolved or abandoned request must not steal a later mount's focus. */
  clearPendingFocus(): void;
  consumePendingFocus(): boolean;
  setOverviewOpen(open: boolean): void;
  toggleOverview(): void;
}

/**
 * Whether the tree pane is shown, shared by the panel's header toggle and the
 * `Ctrl+E` chord, the one-shot focus request the chord leaves when the tree
 * is not mounted yet, and whether the folder overview is up.
 */
export function createFileTreeStore(storage: ExplorerOpenStorage) {
  return create<FileTreeState>((set, get) => ({
    explorerOpen: storage.read() ?? true,
    pendingFocus: false,
    overviewOpen: false,
    setExplorerOpen: (open) => {
      if (get().explorerOpen === open) return;
      storage.write(open);
      set({ explorerOpen: open });
    },
    toggleExplorer: () => get().setExplorerOpen(!get().explorerOpen),
    requestFocus: () => set({ pendingFocus: true }),
    clearPendingFocus: () => set({ pendingFocus: false }),
    consumePendingFocus: () => {
      const pending = get().pendingFocus;
      if (pending) set({ pendingFocus: false });
      return pending;
    },
    setOverviewOpen: (open) => set({ overviewOpen: open }),
    toggleOverview: () => set({ overviewOpen: !get().overviewOpen }),
  }));
}

const explorerOpenStorage = createSchemaLocalStorage(Schema.Boolean, "FILE-TREE");
const localStorageExplorerOpen: ExplorerOpenStorage = {
  read: () => explorerOpenStorage.read(EXPLORER_OPEN_STORAGE_KEY),
  write: (open) => {
    explorerOpenStorage.write(EXPLORER_OPEN_STORAGE_KEY, open);
  },
};

export const useFileTreeStore = createFileTreeStore(localStorageExplorerOpen);
