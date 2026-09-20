import { describe, expect, it } from "vite-plus/test";

import { createFileTreeStore, EXPLORER_OPEN_STORAGE_KEY } from "./fileTreeStore";

function memoryStorage(initial: boolean | null) {
  let stored = initial;
  const writes: boolean[] = [];
  return {
    storage: {
      read: () => stored,
      write: (open: boolean) => {
        stored = open;
        writes.push(open);
      },
    },
    writes,
    current: () => stored,
  };
}

describe("fileTreeStore", () => {
  it("keeps the T3 tree's storage key so an existing preference carries over", () => {
    expect(EXPLORER_OPEN_STORAGE_KEY).toBe("t3code.fileExplorerOpen");
  });

  it("starts open by default and from the stored value when one exists", () => {
    expect(createFileTreeStore(memoryStorage(null).storage).getState().explorerOpen).toBe(true);
    expect(createFileTreeStore(memoryStorage(false).storage).getState().explorerOpen).toBe(false);
  });

  it("persists every change to the open state", () => {
    const memory = memoryStorage(true);
    const store = createFileTreeStore(memory.storage);
    store.getState().setExplorerOpen(false);
    store.getState().toggleExplorer();
    expect(memory.writes).toEqual([false, true]);
    expect(store.getState().explorerOpen).toBe(true);
  });

  it("hands out a pending focus exactly once", () => {
    const store = createFileTreeStore(memoryStorage(true).storage);
    expect(store.getState().consumePendingFocus()).toBe(false);
    store.getState().requestFocus();
    expect(store.getState().consumePendingFocus()).toBe(true);
    expect(store.getState().consumePendingFocus()).toBe(false);
  });
});
