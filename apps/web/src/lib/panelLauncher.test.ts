// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { registerCommandHandlers } from "~/commands/commandRegistry";
import { toastManager } from "~/components/ui/toast";

import {
  closePanelLauncher,
  dismissPanelLauncher,
  openPanelLauncher,
  panelLauncherActions,
  registerLauncherKeyHandler,
  runPanelLauncherAction,
} from "./panelLauncher";

const add = vi.mocked(toastManager.add);
const actionFor = (shortcut: string, hasActiveTab = true) =>
  panelLauncherActions({ hasActiveTab, maximized: false }).find(
    (action) => action.shortcut === shortcut,
  )!;

describe("panel launcher", () => {
  afterEach(() => {
    closePanelLauncher();
    add.mockClear();
    document.body.innerHTML = "";
  });

  it("runs a panel action through the command its owner registered", () => {
    const maximize = vi.fn();
    const dispose = registerCommandHandlers({ "rightPanel.toggleMaximized": maximize });
    runPanelLauncherAction(actionFor("Z"));
    dispose();
    expect(maximize).toHaveBeenCalledOnce();
    expect(add).not.toHaveBeenCalled();
  });

  it("says why an action cannot run instead of doing nothing", () => {
    const close = vi.fn();
    const dispose = registerCommandHandlers({ "rightPanel.close": close });
    runPanelLauncherAction(actionFor("X", false));
    dispose();
    expect(close).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Close tab is not available",
        description: "No tab is open.",
      }),
    );
  });

  it("says so when nothing on the page owns the action", () => {
    runPanelLauncherAction(actionFor("E"));
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ title: "File tree is not available" }),
    );
  });

  it("answers keys ahead of listeners added later, only while open", () => {
    const later = vi.fn();
    window.addEventListener("keydown", later, true);
    const handler = vi.fn(() => true);
    const unregister = registerLauncherKeyHandler(handler);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z" }));
    expect(handler).not.toHaveBeenCalled();
    expect(later).toHaveBeenCalledTimes(1);

    openPanelLauncher();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z" }));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(later).toHaveBeenCalledTimes(1);

    unregister();
    window.removeEventListener("keydown", later, true);
  });

  it("puts focus back where it was when dismissed", () => {
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    openPanelLauncher();
    const launcher = document.createElement("div");
    launcher.tabIndex = 0;
    document.body.append(launcher);
    launcher.focus();
    dismissPanelLauncher();
    expect(document.activeElement).toBe(button);
  });
});
