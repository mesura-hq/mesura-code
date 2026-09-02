import { describe, expect, it } from "vite-plus/test";

import { STATIC_KEYBINDING_COMMANDS } from "@t3tools/contracts";

import { DEFAULT_KEYBINDINGS } from "./keybindings.ts";

/**
 * Keybindings this fork adds on top of upstream's defaults.
 *
 * `composer.attachFiles` is the one ADR-003 kept when the fork's attachment
 * stack was retired for upstream's. Upstream's attach button survives the
 * switch, so nothing was lost there, but upstream ships no keyboard route to
 * attaching at all — their default list has no attach entry of any kind.
 *
 * The binding is cheap to carry and easy to lose: a sync that takes upstream's
 * command list wholesale drops the command, and the shortcut then resolves to
 * nothing while the button keeps working, so no suite notices.
 */

describe("fork keybindings", () => {
  it("binds alt+a to attaching files from the composer", () => {
    const attachBindings = DEFAULT_KEYBINDINGS.filter(
      (binding) => binding.command === "composer.attachFiles",
    );

    expect(attachBindings).toHaveLength(1);
    expect(attachBindings[0]?.key).toBe("alt+a");
    // Not while a terminal owns the keyboard, where alt+a belongs to the shell.
    expect(attachBindings[0]?.when).toBe("!terminalFocus");
  });

  it("registers the attach command so a user can rebind it", () => {
    expect(STATIC_KEYBINDING_COMMANDS).toContain("composer.attachFiles");
  });

  it("leaves alt+a free of any other command in the same context", () => {
    const collisions = DEFAULT_KEYBINDINGS.filter(
      (binding) => binding.key === "alt+a" && binding.command !== "composer.attachFiles",
    );

    expect(collisions).toEqual([]);
  });
});
