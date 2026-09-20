import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { isOpenFavoriteEditorShortcut, resolveShortcutCommand } from "./keybindings";

const state = vi.hoisted(() => ({ open: false }));

vi.mock("~/components/files/mesuraFileManager/isFileManagerOpen", () => ({
  isFileManagerOpen: () => state.open,
}));

const linux = { platform: "Linux x86_64" };
const chord = (key: string, shift = false) => ({
  key,
  ctrlKey: true,
  metaKey: false,
  shiftKey: shift,
  altKey: false,
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
    expect(resolveShortcutCommand(chord("e", true), DEFAULT_RESOLVED_KEYBINDINGS, linux)).toBe(
      "fileTree.miller",
    );
    expect(isOpenFavoriteEditorShortcut(chord("o"), DEFAULT_RESOLVED_KEYBINDINGS, linux)).toBe(
      true,
    );
  });

  it("lets only the file manager's own chord through while it is open", () => {
    state.open = true;
    expect(resolveShortcutCommand(chord("e", true), DEFAULT_RESOLVED_KEYBINDINGS, linux)).toBe(
      "fileTree.miller",
    );
    expect(resolveShortcutCommand(chord("n"), DEFAULT_RESOLVED_KEYBINDINGS, linux)).toBeNull();
    expect(resolveShortcutCommand(chord("k"), DEFAULT_RESOLVED_KEYBINDINGS, linux)).toBeNull();
    expect(resolveShortcutCommand(chord("e"), DEFAULT_RESOLVED_KEYBINDINGS, linux)).toBeNull();
  });

  it("leaves Ctrl+O to the file manager's overview while it is open", () => {
    state.open = true;
    expect(isOpenFavoriteEditorShortcut(chord("o"), DEFAULT_RESOLVED_KEYBINDINGS, linux)).toBe(
      false,
    );
  });
});
