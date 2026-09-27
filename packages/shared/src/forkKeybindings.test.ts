import { describe, expect, it } from "vite-plus/test";

import { STATIC_KEYBINDING_COMMANDS } from "@t3tools/contracts";

import { DEFAULT_KEYBINDINGS } from "./keybindings.ts";

/**
 * The keybindings this fork adds on top of upstream's defaults.
 *
 * `composer.attachFiles` is the one ADR-003 kept when the fork's attachment
 * stack was retired for upstream's: their attach button survives the switch,
 * but upstream ships no keyboard route to attaching at all. `fileTree.toggle`
 * reaches the Symmetria file tree in the files surface and leaves it again;
 * `fileTree.miller` opens the file manager's Miller columns over the window.
 *
 * Each is cheap to carry and easy to lose: a sync that takes upstream's
 * command list wholesale drops the command, and the shortcut then resolves to
 * nothing while the mouse route keeps working, so no suite notices.
 */

const FORK_BINDINGS = [
  { command: "composer.attachFiles", keys: ["alt+a"] },
  { command: "fileTree.toggle", keys: ["mod+e"] },
  // mod+shift+e is back since the fork withdrew v0.0.42's composer.effort
  // default there (alt+e opens the same picker). mod+alt+e stays because
  // Firefox and Zen keep mod+shift+e. The last one is the label.
  { command: "fileTree.miller", keys: ["mod+alt+e", "mod+shift+e"] },
] as const;

describe("fork keybindings", () => {
  for (const { command, keys } of FORK_BINDINGS) {
    describe(command, () => {
      it(`binds ${keys.join(" and ")} outside the terminal, in that order`, () => {
        const bindings = DEFAULT_KEYBINDINGS.filter((binding) => binding.command === command);

        // Order matters: the last binding is the label.
        expect(bindings.map((binding) => binding.key)).toEqual(keys);
        // Not while a terminal owns the keyboard, where the chord belongs to the shell.
        for (const binding of bindings) expect(binding.when).toBe("!terminalFocus");
      });

      it("registers the command so a user can rebind it", () => {
        expect(STATIC_KEYBINDING_COMMANDS).toContain(command);
      });

      it(`leaves ${keys.join(" and ")} free of any other command`, () => {
        const collisions = DEFAULT_KEYBINDINGS.filter(
          (binding) =>
            (keys as ReadonlyArray<string>).includes(binding.key) && binding.command !== command,
        );

        expect(collisions).toEqual([]);
      });
    });
  }
});
