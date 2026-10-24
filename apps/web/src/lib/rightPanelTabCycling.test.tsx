// @vitest-environment happy-dom
// Entry point: `useRightPanelTabCycling` (`rightPanelTabCycling.ts`), the
// window `keydown` listener the right panel's tab bar mounts. Every spec
// dispatches a real `KeyboardEvent` from a focused element; the chords resolve
// through the shipped default keybindings (`ctrl+tab`, `ctrl+shift+tab`,
// `mod+t`, all `panelFocus && !terminalFocus`), and the specs read which
// surface was activated and whether the panel launcher opened.
import { act, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { closePanelLauncher, usePanelLauncherOpen } from "./panelLauncher";
import { useRightPanelTabCycling } from "./rightPanelTabCycling";

const SURFACES = [{ id: "files" }, { id: "diff" }, { id: "terminal" }] as const;

let root: Root;
let activated: string[];
let launcherOpen: boolean;

function TabBarProbe({
  activeSurfaceId,
  panelOpen,
}: {
  readonly activeSurfaceId: string;
  readonly panelOpen: boolean;
}) {
  const tabBarRef = useRef<HTMLDivElement | null>(null);
  const open = usePanelLauncherOpen();
  useLayoutEffect(() => {
    launcherOpen = open;
  });
  useRightPanelTabCycling({
    tabBarRef,
    panelOpen,
    surfaces: SURFACES,
    activeSurfaceId,
    onActivate: (surface) => activated.push(surface.id),
  });
  return <div ref={tabBarRef} data-testid="tabbar" />;
}

function render(activeSurfaceId: string, panelOpen = true): void {
  act(() => root.render(<TabBarProbe activeSurfaceId={activeSurfaceId} panelOpen={panelOpen} />));
}

/** Dispatches a keydown from the focused element, as the browser does. */
function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
  return event;
}

const nextTab = () => press({ key: "Tab", code: "Tab", ctrlKey: true });
const previousTab = () => press({ key: "Tab", code: "Tab", ctrlKey: true, shiftKey: true });
const focusTestId = (id: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.focus();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.innerHTML = `
    <div data-chat-column-maximized-away="false">
      <div data-testid="chat-focus" tabindex="0"></div>
    </div>
    <div data-preview-panel-mode="inline">
      <div data-right-panel-tabbar data-testid="tabbar-host"></div>
      <div data-right-panel-surface-content>
        <div data-testid="surface-focus" tabindex="0"></div>
      </div>
    </div>`;
  activated = [];
  root = createRoot(document.querySelector("[data-testid='tabbar-host']")!);
  render("files");
});

afterEach(() => {
  act(() => closePanelLauncher());
  act(() => root.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("right panel tab cycling in the panel", () => {
  it("activates the next surface on Ctrl+Tab with focus in the panel and consumes the chord", () => {
    focusTestId("surface-focus");
    const event = nextTab();
    expect(activated).toEqual(["diff"]);
    expect(event.defaultPrevented).toBe(true);
  });

  it("activates the previous surface on Ctrl+Shift+Tab with focus in the panel", () => {
    render("diff");
    focusTestId("surface-focus");
    previousTab();
    expect(activated).toEqual(["files"]);
  });

  it("wraps Ctrl+Tab from the last surface to the first and Ctrl+Shift+Tab from the first to the last", () => {
    render("terminal");
    focusTestId("surface-focus");
    nextTab();
    expect(activated).toEqual(["files"]);

    render("files");
    previousTab();
    expect(activated).toEqual(["files", "terminal"]);
  });

  it("opens the panel launcher on Ctrl+T with focus in the panel", () => {
    focusTestId("surface-focus");
    const event = press({ key: "t", code: "KeyT", ctrlKey: true });
    expect(launcherOpen).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(activated).toEqual([]);
  });
});

describe("right panel tab cycling outside the panel", () => {
  it("leaves Ctrl+Tab and Ctrl+Shift+Tab alone with focus in the chat", () => {
    focusTestId("chat-focus");
    const forward = nextTab();
    const back = previousTab();
    expect(activated).toEqual([]);
    expect(forward.defaultPrevented).toBe(false);
    expect(back.defaultPrevented).toBe(false);
  });

  it("leaves Ctrl+Tab alone with focus on the body", () => {
    (document.activeElement as HTMLElement | null)?.blur();
    nextTab();
    expect(activated).toEqual([]);
  });

  it("does not open the panel launcher on Ctrl+T with focus in the chat", () => {
    focusTestId("chat-focus");
    press({ key: "t", code: "KeyT", ctrlKey: true });
    expect(launcherOpen).toBe(false);
  });
});

describe("right panel tab cycling launcher availability regressions", () => {
  it("retains mounted surface focus across close and opens the launcher only after reopening", () => {
    focusTestId("surface-focus");
    render("files", false);
    const closed = press({ key: "t", code: "KeyT", ctrlKey: true });
    expect(launcherOpen).toBe(false);
    expect(closed.defaultPrevented).toBe(false);
    expect(document.activeElement?.getAttribute("data-testid")).toBe("surface-focus");

    render("files", true);
    const reopened = press({ key: "t", code: "KeyT", ctrlKey: true });
    expect(launcherOpen).toBe(true);
    expect(reopened.defaultPrevented).toBe(true);
  });

  it("defers the focused panel new-tab chord to a blocking popup until it closes", () => {
    focusTestId("surface-focus");
    const popup = document.createElement("div");
    popup.dataset.slot = "dialog-popup";
    document.body.append(popup);
    const blocked = press({ key: "t", code: "KeyT", ctrlKey: true });
    expect(launcherOpen).toBe(false);
    expect(blocked.defaultPrevented).toBe(false);

    popup.remove();
    const unblocked = press({ key: "t", code: "KeyT", ctrlKey: true });
    expect(launcherOpen).toBe(true);
    expect(unblocked.defaultPrevented).toBe(true);
  });

  it("preserves terminal new-tab and tab-cycling chords with a terminal focused inside the panel", () => {
    const surface = document.querySelector<HTMLElement>("[data-testid='surface-focus']")!;
    surface.dataset.terminalOwner = "right-panel";
    surface.focus();
    const newTab = press({ key: "t", code: "KeyT", ctrlKey: true });
    const forward = nextTab();
    const back = previousTab();
    expect(launcherOpen).toBe(false);
    expect(activated).toEqual([]);
    expect(newTab.defaultPrevented).toBe(false);
    expect(forward.defaultPrevented).toBe(false);
    expect(back.defaultPrevented).toBe(false);
  });
});
