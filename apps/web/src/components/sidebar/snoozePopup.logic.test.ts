// Phase 2 pure fence: command catalog, default leader map, popup rows, and navigation.
// Popup behavior is covered through AppRoot in AppRoot.snoozeKeys.fence.browser.test.tsx.
import { expect, it } from "vite-plus/test";
import { STATIC_KEYBINDING_COMMANDS } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { DEFAULT_KEYMAP } from "../../keys/defaultKeymap";
import { moveSnoozeHighlight, snoozePopupRows } from "./snoozePopup.logic";

it("snooze keys phase 2 rows: wake keeps preset hints stable and preserves resolved preset objects", () => {
  const presets = [
    {
      id: "after:15",
      label: "15 minutes",
      whenLabel: "12:15 PM",
      snoozedUntil: "2026-11-02T12:15:00.000Z",
    },
    {
      id: "after:60",
      label: "1 hour",
      whenLabel: "1:00 PM",
      snoozedUntil: "2026-11-02T13:00:00.000Z",
    },
  ];
  const awake = snoozePopupRows(presets, false);
  const asleep = snoozePopupRows(presets, true);
  expect(awake.map((row) => row.hint)).toEqual(["1", "2", "c"]);
  expect(asleep.map((row) => row.hint)).toEqual(["w", "1", "2", "c"]);
  expect(asleep.slice(1)).toEqual(awake);
  expect(awake[0]).toHaveProperty("preset", presets[0]);
  expect(snoozePopupRows([], false)).toEqual([{ kind: "custom", hint: "c", label: "Custom…" }]);
});

it("snooze keys phase 2 highlight: navigation wraps in both directions including the custom row", () => {
  expect(moveSnoozeHighlight(0, -1, 9)).toBe(8);
  expect(moveSnoozeHighlight(8, 1, 9)).toBe(0);
  expect(moveSnoozeHighlight(1, -1, 9)).toBe(0);
  expect(moveSnoozeHighlight(0, 1, 0)).toBe(0);
});

it("snooze keys phase 2 AC1 catalog: three chordless snooze commands bridge to the leader group", () => {
  const commands = ["thread.snooze", "thread.unsnooze", "sidebar.toggleSnoozed"];
  expect(STATIC_KEYBINDING_COMMANDS).toEqual(expect.arrayContaining(commands));
  expect(DEFAULT_RESOLVED_KEYBINDINGS.filter((rule) => commands.includes(rule.command))).toEqual(
    [],
  );
  expect(DEFAULT_KEYMAP.groups).toContainEqual({ keys: "<leader>z", label: "snooze" });
  for (const [keys, command, label] of [
    ["<leader>zz", "thread.snooze", "Snooze…"],
    ["<leader>zs", "sidebar.toggleSnoozed", "Snoozed section"],
    ["<leader>zu", "thread.unsnooze", "Wake thread"],
  ])
    expect(DEFAULT_KEYMAP.bindings).toContainEqual(
      expect.objectContaining({ keys, command, label }),
    );
});

it("snooze keys phase 2 guard keymap: existing leader groups and thread actions retain their keys", () => {
  expect(DEFAULT_KEYMAP.groups).toEqual(
    expect.arrayContaining([
      { keys: "<leader>f", label: "find" },
      { keys: "<leader>t", label: "thread" },
      { keys: "<leader>m", label: "composer" },
      { keys: "]", label: "next" },
      { keys: "[", label: "previous" },
    ]),
  );
  for (const [keys, command] of [
    ["<leader>tw", "sidebar.toggleWorking"],
    ["<leader>ts", "thread.settle"],
    ["<leader>tp", "thread.pin"],
    ["<leader>tr", "thread.rename"],
    ["<leader>fc", "commandPalette.toggle"],
  ])
    expect(DEFAULT_KEYMAP.bindings).toContainEqual(expect.objectContaining({ keys, command }));
});
