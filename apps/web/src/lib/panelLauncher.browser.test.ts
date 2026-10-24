
import { describe, expect, it, vi } from "vite-plus/test";

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
  async function setupBrowserFixture0() {


return {async [Symbol.asyncDispose]() {

    closePanelLauncher();
    add.mockClear();
    document.body.innerHTML = "";
  
}};
}

  it("runs a panel action through the command its owner registered", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

    const maximize = vi.fn();
    const dispose = registerCommandHandlers({ "rightPanel.toggleMaximized": maximize });
    runPanelLauncherAction(actionFor("Z"));
    dispose();
    expect(maximize).toHaveBeenCalledOnce();
    expect(add).not.toHaveBeenCalled();
  });

  it("says why an action cannot run instead of doing nothing", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

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

  it("says so when nothing on the page owns the action", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

    runPanelLauncherAction(actionFor("E"));
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ title: "File tree is not available" }),
    );
  });

  it("answers keys ahead of listeners added later, only while open", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

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

  it("panel launcher P1-2: a second inactive key owner cannot hide the active launcher from a surface handler", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

    const unregisterActive = registerLauncherKeyHandler((event) => {
      event.preventDefault();
      return true;
    });
    const unregisterInactive = registerLauncherKeyHandler(() => false);
    const surface = vi.fn();
    window.addEventListener("keydown", surface, true);
    try {
      openPanelLauncher();
      const event = new KeyboardEvent("keydown", { key: "f", cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(surface).not.toHaveBeenCalled();
      unregisterInactive();
      const restored = new KeyboardEvent("keydown", { key: "f", cancelable: true });
      window.dispatchEvent(restored);
      expect(restored.defaultPrevented).toBe(true);
      expect(surface).not.toHaveBeenCalled();
    } finally {
      unregisterInactive();
      unregisterActive();
      window.removeEventListener("keydown", surface, true);
    }
  });

  it("puts focus back where it was when dismissed", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

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
