import { describe, expect, it } from "vite-plus/test";

import { createFileManagerStore } from "./fileManagerStore";

describe("the file manager store", () => {
  it("starts closed and toggles", () => {
    const store = createFileManagerStore();
    expect(store.getState().open).toBe(false);

    store.getState().toggle();
    expect(store.getState().open).toBe(true);
    store.getState().toggle();
    expect(store.getState().open).toBe(false);
  });

  it("sets an explicit state and ignores a no-op set", () => {
    const store = createFileManagerStore();
    let changes = 0;
    store.subscribe(() => {
      changes += 1;
    });

    store.getState().setOpen(true);
    store.getState().setOpen(true);
    store.getState().setOpen(false);

    expect(store.getState().open).toBe(false);
    expect(changes).toBe(2);
  });
});
