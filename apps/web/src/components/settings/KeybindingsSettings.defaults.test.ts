import { DEFAULT_KEYBINDINGS, parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import { expect, it } from "vite-plus/test";

import { shortcutToKeybindingInput } from "./KeybindingsSettings.logic";

// Settings edits and removes a rule by the key text it renders, and the server matches that text
// exactly. A default spelled any other way (`alt+escape` for `alt+esc`) gains a second rule on edit
// instead of being replaced, and cannot be removed.
it("spells every default the way Settings writes it back", () => {
  const respelled = DEFAULT_KEYBINDINGS.flatMap((rule) => {
    const shortcut = parseKeybindingShortcut(rule.key);
    const written = shortcut ? shortcutToKeybindingInput(shortcut) : null;
    return written === rule.key ? [] : [{ command: rule.command, key: rule.key, written }];
  });

  expect(respelled).toEqual([]);
});
