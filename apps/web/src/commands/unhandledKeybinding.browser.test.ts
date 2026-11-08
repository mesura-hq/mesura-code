import { expect, it, vi } from "vite-plus/test";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { fakeTimers } from "../../test/render";
import { resolveShortcutCommand } from "../keybindings";

it("reports a resolved shortcut when no listener claims it, once per event", () => {
  using _timers = fakeTimers();
  using warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const event = new KeyboardEvent("keydown", {
    key: "S",
    ctrlKey: true,
    shiftKey: true,
    cancelable: true,
  });
  const options = { platform: "Linux", context: { terminalFocus: false } };
  expect(resolveShortcutCommand(event, DEFAULT_RESOLVED_KEYBINDINGS, options)).toBe(
    "thread.settle",
  );
  resolveShortcutCommand(event, DEFAULT_RESOLVED_KEYBINDINGS, options);
  expect(warning).not.toHaveBeenCalled();
  vi.runAllTimers();
  expect(warning).toHaveBeenCalledExactlyOnceWith(
    "[keybindings] No handler claimed a resolved shortcut; check command ownership and the active view",
    { commands: ["thread.settle"] },
  );
});

it("waits for later window listeners and stays quiet when a handler claims the shortcut", () => {
  using _timers = fakeTimers();
  using warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const event = new KeyboardEvent("keydown", {
    key: "S",
    ctrlKey: true,
    shiftKey: true,
    cancelable: true,
  });
  resolveShortcutCommand(event, DEFAULT_RESOLVED_KEYBINDINGS, { platform: "Linux" });
  event.preventDefault();
  vi.runAllTimers();
  expect(warning).not.toHaveBeenCalled();
});
