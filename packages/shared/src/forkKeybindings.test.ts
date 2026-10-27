import { describe, expect, it } from "vite-plus/test";

import { STATIC_KEYBINDING_COMMANDS } from "@t3tools/contracts";

import { DEFAULT_KEYBINDINGS } from "./keybindings.ts";

/**
 * Keybindings this fork adds on top of upstream's defaults, each a keyboard route upstream lacks.
 * A sync that takes upstream's command list wholesale drops the command; the shortcut then resolves
 * to nothing while the mouse route keeps working, so no other suite notices.
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
  // The Diff surface's Tree diff mode and its mode menu. mod+shift+g, the
  // chord Symmetria IDE used, is composer.branch here.
  { command: "treeDiff.toggle", keys: ["alt+g"] },
  { command: "diff.modeMenu", keys: ["alt+c"] },
  // Search unification: flips the sidebar between All projects and the last
  // project. mod+shift+p stays thread.pin; mod+shift+0 types `=` on the Latin
  // American layout.
  { command: "projectScope.toggleAll", keys: ["mod+alt+p"] },
] as const;

describe("fork keybindings", () => {
  describe.each(FORK_BINDINGS)("$command", ({ command, keys }) => {
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
    // Dictation's save mode shares the chord only while a dictation is live, and comes after
    // the peek so last-wins resolution picks it then and only then.
    const collisions = DEFAULT_KEYBINDINGS.filter(
      (binding) =>
        binding.key === "alt+s" &&
        binding.command !== "hosts.peek" &&
        !(binding.command === "dictation.mode.clipboard" && binding.when === "dictationActive"),
    );
    expect(collisions).toEqual([]);
    const order = DEFAULT_KEYBINDINGS.filter((binding) => binding.key === "alt+s").map(
      (binding) => binding.command,
    );
    expect(order).toEqual(["hosts.peek", "dictation.mode.clipboard"]);
  });
});

// Search unification phase 1, criterion 7, guard: the all-projects toggle took
// a new chord, so the pin keeps its own.
describe("thread.pin beside projectScope.toggleAll", () => {
  it("pin guard: mod+shift+p still pins the current thread outside the terminal", () => {
    const bindings = DEFAULT_KEYBINDINGS.filter((binding) => binding.key === "mod+shift+p");
    expect(bindings.map((binding) => [binding.command, binding.when])).toEqual([
      ["thread.pin", "!terminalFocus"],
    ]);
  });
});
