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
// `fileTree.miller` moved from mod+shift+e to mod+alt+e when v0.0.42 claimed
// mod+shift+e for `composer.effort`. See RETIRED in shared/keybindings.
const modAltChord = (key: string) => ({
  key,
  ctrlKey: true,
  metaKey: false,
  shiftKey: false,
  altKey: true,
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
    expect(resolveShortcutCommand(modAltChord("e"), DEFAULT_RESOLVED_KEYBINDINGS, linux)).toBe(
      "fileTree.miller",
    );
    // `editor.openFavorite` answers to alt+o, not mod+o. The pane-navigation
    // work moved it there to free mod+k for `pane.focusUp`, which pushed
    // `commandPalette.toggle` onto mod+o. Asserting mod+o here instead would
    // pass for the wrong reason once the command moved, which is exactly what
    // happened: this line read `chord("o")` and went false when the two
    // changes met.
    expect(isOpenFavoriteEditorShortcut(altChord("o"), DEFAULT_RESOLVED_KEYBINDINGS, linux)).toBe(
      true,
    );
  });

  it("lets only the file manager's own chord through while it is open", () => {
    state.open = true;
    expect(resolveShortcutCommand(modAltChord("e"), DEFAULT_RESOLVED_KEYBINDINGS, linux)).toBe(
      "fileTree.miller",
    );
    expect(resolveShortcutCommand(chord("n"), DEFAULT_RESOLVED_KEYBINDINGS, linux)).toBeNull();
    expect(resolveShortcutCommand(chord("k"), DEFAULT_RESOLVED_KEYBINDINGS, linux)).toBeNull();
    expect(resolveShortcutCommand(chord("e"), DEFAULT_RESOLVED_KEYBINDINGS, linux)).toBeNull();
  });

  /**
   * Ctrl+O is the file manager's overview chord, so the host must not answer it
   * while the file manager is up.
   *
   * Asserted through `resolveShortcutCommand` rather than through
   * `isOpenFavoriteEditorShortcut`, because that helper now reports false for
   * mod+o in BOTH states — `editor.openFavorite` lives on alt+o. A guard that
   * cannot fail is worse than no guard: it reads as coverage and proves
   * nothing. The host command competing for mod+o today is
   * `commandPalette.toggle`.
   */
  it("leaves Ctrl+O to the file manager's overview while it is open", () => {
    expect(resolveShortcutCommand(chord("o"), DEFAULT_RESOLVED_KEYBINDINGS, linux)).toBe(
      "commandPalette.toggle",
    );
    state.open = true;
    expect(resolveShortcutCommand(chord("o"), DEFAULT_RESOLVED_KEYBINDINGS, linux)).toBeNull();
  });
});
