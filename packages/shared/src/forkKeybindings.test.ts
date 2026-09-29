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
 * `thread.rename` opens the header's title rename, which upstream reaches only
 * by double-click and the thread menu.
 *
 * Each is cheap to carry and easy to lose: a sync that takes upstream's
 * command list wholesale drops the command, and the shortcut then resolves to
 * nothing while the mouse route keeps working, so no suite notices.
 */

const FORK_BINDINGS = [
  // mod+alt+a is the label because Hyprland setups often keep ALT+A globally.
  { command: "composer.attachFiles", keys: ["alt+a", "mod+alt+a"] },
  { command: "fileTree.toggle", keys: ["mod+e"] },
  // mod+shift+e is back since the fork withdrew v0.0.42's composer.effort
  // default there (alt+e opens the same picker). mod+alt+e stays because
  // Firefox and Zen keep mod+shift+e. The last one is the label.
  { command: "fileTree.miller", keys: ["mod+alt+e", "mod+shift+e"] },
  { command: "thread.rename", keys: ["mod+alt+r"] },
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

// The Hosts dock peeks on alt+s the way the usage dock peeks on alt+u: held,
// and with no `when` clause, because both docks open over a focused terminal
// too. That is why it sits outside FORK_BINDINGS, whose rules all require
// `!terminalFocus`.
describe("hosts.peek", () => {
  it("binds alt+s to the hosts peek everywhere, like usage.peek", () => {
    const bindings = DEFAULT_KEYBINDINGS.filter((binding) => binding.command === "hosts.peek");
    expect(bindings.map((binding) => binding.key)).toEqual(["alt+s"]);
    expect(bindings[0]?.when).toBeUndefined();
    const usage = DEFAULT_KEYBINDINGS.find((binding) => binding.command === "usage.peek");
    expect(usage?.when).toBeUndefined();
  });

  it("registers hosts.peek so a user can rebind it", () => {
    expect(STATIC_KEYBINDING_COMMANDS).toContain("hosts.peek");
  });

  it("leaves alt+s free of any command but the hosts peek", () => {
    const collisions = DEFAULT_KEYBINDINGS.filter(
      (binding) => binding.key === "alt+s" && binding.command !== "hosts.peek",
    );
    expect(collisions).toEqual([]);
  });
});
