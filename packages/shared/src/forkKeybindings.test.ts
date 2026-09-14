import { describe, expect, it } from "vite-plus/test";

import { STATIC_KEYBINDING_COMMANDS } from "@t3tools/contracts";

import { DEFAULT_KEYBINDINGS } from "./keybindings.ts";

/**
 * The keybindings this fork adds on top of upstream's defaults.
 *
 * `composer.attachFiles` is the one ADR-003 kept when the fork's attachment
 * stack was retired for upstream's: their attach button survives the switch,
 * but upstream ships no keyboard route to attaching at all. `fileTree.toggle`
 * reaches the Symmetria file tree in the files surface and leaves it again.
 *
 * Each is cheap to carry and easy to lose: a sync that takes upstream's
 * command list wholesale drops the command, and the shortcut then resolves to
 * nothing while the mouse route keeps working, so no suite notices.
 */

const FORK_BINDINGS = [
  { command: "composer.attachFiles", key: "alt+a" },
  { command: "fileTree.toggle", key: "mod+e" },
] as const;

describe("fork keybindings", () => {
  for (const { command, key } of FORK_BINDINGS) {
    describe(command, () => {
      it(`binds ${key} outside the terminal`, () => {
        const bindings = DEFAULT_KEYBINDINGS.filter((binding) => binding.command === command);

        expect(bindings).toHaveLength(1);
        expect(bindings[0]?.key).toBe(key);
        // Not while a terminal owns the keyboard, where the chord belongs to the shell.
        expect(bindings[0]?.when).toBe("!terminalFocus");
      });

      it("registers the command so a user can rebind it", () => {
        expect(STATIC_KEYBINDING_COMMANDS).toContain(command);
      });

      it(`leaves ${key} free of any other command`, () => {
        const collisions = DEFAULT_KEYBINDINGS.filter(
          (binding) => binding.key === key && binding.command !== command,
        );

        expect(collisions).toEqual([]);
      });
    });
  }
});
