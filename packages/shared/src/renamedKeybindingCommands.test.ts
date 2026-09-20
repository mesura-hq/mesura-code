import { describe, expect, it } from "vite-plus/test";

import { withCurrentKeybindingCommand } from "./renamedKeybindingCommands.ts";

describe("a stored rule with a renamed command", () => {
  it("is brought up to date, keeping its key and clause", () => {
    expect(
      withCurrentKeybindingCommand({
        key: "mod+shift+e",
        command: "fileTree.overview",
        when: "!terminalFocus",
      }),
    ).toEqual({ key: "mod+shift+e", command: "fileTree.miller", when: "!terminalFocus" });
  });

  it("leaves every other entry alone, malformed ones included", () => {
    const current = { key: "mod+e", command: "fileTree.toggle" };
    expect(withCurrentKeybindingCommand(current)).toBe(current);
    expect(withCurrentKeybindingCommand("not an entry")).toBe("not an entry");
    expect(withCurrentKeybindingCommand(null)).toBeNull();
  });
});
