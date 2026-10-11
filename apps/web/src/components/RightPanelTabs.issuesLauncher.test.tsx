// @vitest-environment happy-dom
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
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { closePanelLauncher } from "~/lib/panelLauncher";

import { RightPanelTabs } from "./RightPanelTabs";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

type TabsProps = ComponentProps<typeof RightPanelTabs>;

function mountTabs(overrides: Partial<TabsProps> = {}) {
  const callbacks = {
    onAddIssues: vi.fn(),
    onAddBrowser: vi.fn(),
    onAddTerminal: vi.fn(),
    onAddPullRequests: vi.fn(),
  };
  const props: TabsProps = {
    mode: "inline",
    surfaces: [],
    environmentId: null,
    activeSurfaceId: null,
    pendingSurfaceIds: new Set(),
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
    onAddAgents: () => undefined,
    onAddDevice: () => undefined,
    liveAgentCount: 0,
    browserAvailable: false,
    terminalAvailable: true,
    diffAvailable: false,
    filesAvailable: false,
    pullRequestAvailable: false,
    pullRequestsAvailable: true,
    agentsAvailable: false,
    deviceAvailable: false,
    children: <div>surface content</div>,
    ...callbacks,
    ...overrides,
  } as TabsProps;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(<RightPanelTabs {...props} />);
  });
  return callbacks;
}

function press(target: Element, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  act(() => {
    closePanelLauncher();
    root?.unmount();
  });
  container?.remove();
  document.body.replaceChildren();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("Issues launcher guard: the contextual I shortcut", () => {
  it("issues launcher guard: bare I on the surface launcher opens Issues and nothing else", () => {
    const callbacks = mountTabs();
    const event = press(document.activeElement ?? document.body, "i");

    expect(callbacks.onAddIssues).toHaveBeenCalledTimes(1);
    expect(callbacks.onAddTerminal).not.toHaveBeenCalled();
    expect(callbacks.onAddPullRequests).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("issues launcher guard: I typed into a text field or terminal input stays text", () => {
    const callbacks = mountTabs();
    const field = document.createElement("input");
    // xterm.js receives keystrokes through this hidden helper textarea.
    const terminal = document.createElement("textarea");
    terminal.className = "xterm-helper-textarea";
    const composer = document.createElement("div");
    composer.setAttribute("contenteditable", "true");
    document.body.append(field, terminal, composer);

    for (const target of [field, terminal, composer]) {
      const event = press(target, "i");
      expect(event.defaultPrevented).toBe(false);
    }
    expect(callbacks.onAddIssues).not.toHaveBeenCalled();
  });

  it("issues launcher guard: I is left alone while a blocking overlay owns focus or with a modifier", () => {
    const callbacks = mountTabs();
    press(document.body, "i", { ctrlKey: true });
    press(document.body, "i", { metaKey: true });
    press(document.body, "i", { altKey: true });

    const dialog = document.createElement("div");
    dialog.setAttribute("data-slot", "dialog-popup");
    document.body.append(dialog);
    press(dialog, "i");

    expect(callbacks.onAddIssues).not.toHaveBeenCalled();
  });

  it("issues launcher guard: without a GitHub project I opens nothing", () => {
    const callbacks = mountTabs({ onAddIssues: undefined });
    press(document.body, "i");

    expect(callbacks.onAddTerminal).not.toHaveBeenCalled();
    expect(callbacks.onAddPullRequests).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Issues");
  });

  it("issues launcher guard: I inside the Add surface launcher opens Issues and closes the launcher", async () => {
    const callbacks = mountTabs({
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

    press(launcher!, "i");

    expect(callbacks.onAddIssues).toHaveBeenCalledTimes(1);
    expect(container!.querySelector('[aria-label="Open a surface"]')).toBeNull();
  });
});
