import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import { resolveShortcutCommand } from "~/keybindings";

import { APP_SHORTCUTS_THAT_OUTRANK_NEOVIM } from "./appShortcutsThatOutrankNeovim";

describe("app shortcuts that outrank Neovim", () => {
  it("is exactly the file picker, the file tree toggle, the file manager, Tree diff and the Diff mode menu", () => {
    expect([...APP_SHORTCUTS_THAT_OUTRANK_NEOVIM].toSorted()).toEqual([
      "diff.modeMenu",
      "filePicker.toggle",
      "fileTree.miller",
      "fileTree.toggle",
      "treeDiff.toggle",
    ]);
  });

  /**
   * The Neovim editor cannot mount under happy-dom, so this asks the question
   * `useNvimFileEditor`'s `isAppShortcut` asks of every key the editor sees:
   * resolve the chord outside the terminal, then look the command up here.
   */
  it("lets Alt+G reach Tree diff and Alt+C the Diff mode menu from inside the editor", () => {
    const resolveInEditor = (key: string) =>
      resolveShortcutCommand(
        { key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: true },
        DEFAULT_RESOLVED_KEYBINDINGS,
        { platform: "Linux x86_64", context: { terminalFocus: false } },
      );
    expect(resolveInEditor("g")).toBe("treeDiff.toggle");
    expect(resolveInEditor("c")).toBe("diff.modeMenu");
    expect(APP_SHORTCUTS_THAT_OUTRANK_NEOVIM.has("treeDiff.toggle")).toBe(true);
    expect(APP_SHORTCUTS_THAT_OUTRANK_NEOVIM.has("diff.modeMenu")).toBe(true);
  });
});
