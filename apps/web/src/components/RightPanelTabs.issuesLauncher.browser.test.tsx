import { act, render as renderBrowser, type Screen } from "../../test/render";
/**
 * Entry point: the real `RightPanelTabs`, as `ChatView` mounts it for a thread's right panel.
 * With no surfaces it renders the surface launcher; with one surface it renders the tab strip and
 * its Add surface launcher. Keys are dispatched as the browser would deliver them, at the focused
 * element.
 *
 * Issues pane, phase 2: acceptance criteria 1–2 for the contextual `I` shortcut. These are guards:
 * the prototype already routes Issues through the shared surface shortcut machinery.
 */
import type { ComponentProps } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

import { closePanelLauncher } from "~/lib/panelLauncher";

import { RightPanelTabs } from "./RightPanelTabs";

let root: Screen | null = null;
let container: HTMLDivElement | null = null;

type TabsProps = ComponentProps<typeof RightPanelTabs>;

async function mountTabs(overrides: Partial<TabsProps> = {}) {
  const callbacks = {
    onAddIssues: vi.fn(),
    onAddBrowser: vi.fn(),
    onAddTerminal: vi.fn(),
    onAddPullRequests: vi.fn(),
  };
  const props: TabsProps = {
    mode: "inline",
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    getShortcutContext: () => ({
      terminalFocus: false,
      terminalOpen: false,
      previewFocus: false,
      previewOpen: false,
      isWeb: true,
      isDesktop: false,
    }),
    surfaces: [],
    environmentId: null,
    activeSurfaceId: null,
    pendingProjectKey: null,
    previewSessions: {},
    desktopByTabId: {},
    terminalLabelsById: new Map(),
    onActivate: () => undefined,
    onCloseSurface: () => undefined,
    onCloseOtherSurfaces: () => undefined,
    onCloseSurfacesToRight: () => undefined,
    onCloseAllSurfaces: () => undefined,
    onCopyFilePath: () => undefined,
    onAddBrowserInProfile: () => undefined,
    onAddDiff: () => undefined,
    onAddFiles: () => undefined,
    onAddPullRequest: () => undefined,
    onAddDevice: () => undefined,
    browserAvailable: false,
    terminalAvailable: true,
    diffAvailable: false,
    filesAvailable: false,
    pullRequestAvailable: false,
    pullRequestsAvailable: true,
    deviceAvailable: false,
    children: <div>surface content</div>,
    ...callbacks,
    ...overrides,
  };
  container = document.createElement("div");
  document.body.append(container);
  root = await renderBrowser(null, { container: container, router: false });
  await act(async () => {
    await root!.rerender(<RightPanelTabs {...props} />);
  });
  return callbacks;
}

async function press(target: Element, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

async function setupBrowserFixture0() {




return {async [Symbol.asyncDispose]() {

  await act(() => {
    closePanelLauncher();
    root?.[Symbol.asyncDispose]();
  });
  container?.remove();
  document.body.replaceChildren();
  root = null;
  container = null;
  vi.unstubAllGlobals();

}};
}



describe("Issues launcher guard: the contextual I shortcut", () => {
  it("issues launcher guard: bare I on the surface launcher opens Issues and nothing else", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

    const callbacks = await mountTabs();
    const event = await press(document.activeElement ?? document.body, "i");

    expect(callbacks.onAddIssues).toHaveBeenCalledTimes(1);
    expect(callbacks.onAddTerminal).not.toHaveBeenCalled();
    expect(callbacks.onAddPullRequests).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("issues launcher guard: I typed into a text field or terminal input stays text", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

    const callbacks = await mountTabs();
    const field = document.createElement("input");
    // xterm.js receives keystrokes through this hidden helper textarea.
    const terminal = document.createElement("textarea");
    terminal.className = "xterm-helper-textarea";
    const composer = document.createElement("div");
    composer.setAttribute("contenteditable", "true");
    document.body.append(field, terminal, composer);

    for (const target of [field, terminal, composer]) {
      const event = await press(target, "i");
      expect(event.defaultPrevented).toBe(false);
    }
    expect(callbacks.onAddIssues).not.toHaveBeenCalled();
  });

  it("issues launcher guard: I is left alone while a blocking overlay owns focus or with a modifier", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

    const callbacks = await mountTabs();
    await press(document.body, "i", { ctrlKey: true });
    await press(document.body, "i", { metaKey: true });
    await press(document.body, "i", { altKey: true });

    const dialog = document.createElement("div");
    dialog.setAttribute("data-slot", "dialog-popup");
    document.body.append(dialog);
    await press(dialog, "i");

    expect(callbacks.onAddIssues).not.toHaveBeenCalled();
  });

  it("issues launcher guard: without a GitHub project I opens nothing", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

    const callbacks = await mountTabs({ onAddIssues: undefined });
    await press(document.body, "i");

    expect(callbacks.onAddTerminal).not.toHaveBeenCalled();
    expect(callbacks.onAddPullRequests).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Issues");
  });

  it("issues launcher guard: I inside the Add surface launcher opens Issues and closes the launcher", async () => {
await using _browserFixture0 = await setupBrowserFixture0();

    const callbacks = await mountTabs({
      surfaces: [{ id: "pull-requests", kind: "pull-requests" }],
      activeSurfaceId: "pull-requests",
    });
    const trigger = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="Add panel surface"]',
    )!;
    await act(async () => {
      trigger.click();
    });
    const launcher = container!.querySelector('[aria-label="Open a surface"]');
    expect(launcher?.textContent).toContain("Issues");

    await press(launcher!, "i");

    expect(callbacks.onAddIssues).toHaveBeenCalledTimes(1);
    expect(container!.querySelector('[aria-label="Open a surface"]')).toBeNull();
  });
});
