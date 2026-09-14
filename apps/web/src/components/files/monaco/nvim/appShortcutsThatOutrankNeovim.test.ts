import { describe, expect, it } from "vite-plus/test";

import { APP_SHORTCUTS_THAT_OUTRANK_NEOVIM } from "./appShortcutsThatOutrankNeovim";

describe("app shortcuts that outrank Neovim", () => {
  it("is exactly the file picker, the file tree toggle and the file manager", () => {
    expect([...APP_SHORTCUTS_THAT_OUTRANK_NEOVIM].toSorted()).toEqual([
      "filePicker.toggle",
      "fileTree.miller",
      "fileTree.toggle",
    ]);
  });
});
