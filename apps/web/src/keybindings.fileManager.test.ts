import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { isOpenFavoriteEditorShortcut, resolveShortcutCommand } from "./keybindings";

const state = vi.hoisted(() => ({ open: false }));

vi.mock("~/components/files/mesuraFileManager/isFileManagerOpen", () => ({
  isFileManagerOpen: () => state.open,
}));

const linux = { platform: "Linux x86_64" };
const chord = (key: string) => ({
  key,
  ctrlKey: true,
  metaKey: false,
  shiftKey: false,
  altKey: false,
});
const modShiftChord = (key: string) => ({
  key,
  ctrlKey: true,
  metaKey: false,
  shiftKey: true,
  altKey: false,
});

const altChord = (key: string) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: true,
});

/**
 * Every window listener resolves its chord through `resolveShortcutCommand`
 * or one of the `is*Shortcut` helpers over it, so one guard there is what
 * keeps the host's chords out of the file manager while it is up.
 */
describe("host chords while the file manager is open", () => {
  beforeEach(() => {
    state.open = false;
  });

  it("resolves as usual while the file manager is closed", () => {
    expect(resolveShortcutCommand(chord("n"), DEFAULT_RESOLVED_KEYBINDINGS, linux)).toBe(
      "chat.new",
    );
    expect(resolveShortcutCommand(modShiftChord("E"), DEFAULT_RESOLVED_KEYBINDINGS, linux)).toBe(
      "fileTree.miller",
    );
    // The browser-safe second chord: Firefox and Zen keep mod+shift+e.
    expect(
      resolveShortcutCommand(
        { key: "e", ctrlKey: true, metaKey: false, shiftKey: false, altKey: true },
        DEFAULT_RESOLVED_KEYBINDINGS,
        linux,
      ),
    ).toBe("fileTree.miller");
    // `editor.openFavorite` answers to alt+o; mod+o belongs to `commandPalette.toggle`.
    // Asserting mod+o here would pass for the wrong reason, as it once did.
    expect(isOpenFavoriteEditorShortcut(altChord("o"), DEFAULT_RESOLVED_KEYBINDINGS, linux)).toBe(
      true,
    );
  });

  it("lets only the file manager's own chord through while it is open", () => {
    state.open = true;
    expect(resolveShortcutCommand(modShiftChord("E"), DEFAULT_RESOLVED_KEYBINDINGS, linux)).toBe(
      "fileTree.miller",
    );
    expect(resolveShortcutCommand(chord("n"), DEFAULT_RESOLVED_KEYBINDINGS, linux)).toBeNull();
    expect(resolveShortcutCommand(chord("k"), DEFAULT_RESOLVED_KEYBINDINGS, linux)).toBeNull();
    expect(resolveShortcutCommand(chord("e"), DEFAULT_RESOLVED_KEYBINDINGS, linux)).toBeNull();
  });

  /**
   * Ctrl+O is the file manager's overview chord, so the host must not answer it then.
   * Asserted through `resolveShortcutCommand`: `isOpenFavoriteEditorShortcut` reports
   * false for mod+o in both states, so a guard through it could not fail.
   */
  it("leaves Ctrl+O to the file manager's overview while it is open", () => {
    expect(resolveShortcutCommand(chord("o"), DEFAULT_RESOLVED_KEYBINDINGS, linux)).toBe(
      "commandPalette.toggle",
    );
    state.open = true;
    expect(resolveShortcutCommand(chord("o"), DEFAULT_RESOLVED_KEYBINDINGS, linux)).toBeNull();
  });
});
