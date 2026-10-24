import { act, render as renderBrowser, type Screen } from "../../test/render";
// Entry point: `useRightPanelTabCycling` (`rightPanelTabCycling.ts`), the
// window `keydown` listener the right panel's tab bar mounts. Every spec
// dispatches a real `KeyboardEvent` from a focused element; the chords resolve
// through the shipped default keybindings (`ctrl+tab`, `ctrl+shift+tab`,
// `mod+t`, all `panelFocus && !terminalFocus`), and the specs read which
// surface was activated and whether the panel launcher opened.
import { useLayoutEffect, useRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { closePanelLauncher, usePanelLauncherOpen } from "./panelLauncher";
import { useRightPanelTabCycling } from "./rightPanelTabCycling";

const SURFACES = [{ id: "files" }, { id: "diff" }, { id: "terminal" }] as const;

let root: Screen;
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

async function render(activeSurfaceId: string, panelOpen = true): Promise<void> {
  await act(
    async () =>
      await root.rerender(<TabBarProbe activeSurfaceId={activeSurfaceId} panelOpen={panelOpen} />),
  );
}

/** Dispatches a keydown from the focused element, as the browser does. */
async function press(init: KeyboardEventInit): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(() => {
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
  return event;
}

const nextTab = async () => await press({ key: "Tab", code: "Tab", ctrlKey: true });
const previousTab = async () =>
  await press({ key: "Tab", code: "Tab", ctrlKey: true, shiftKey: true });
const focusTestId = (id: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.focus();

async function setupBrowserFixture0() {
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
  root = await renderBrowser(null, {
    container: document.querySelector("[data-testid='tabbar-host']")!,
    router: false,
  });
  await render("files");

  return {
    async [Symbol.asyncDispose]() {
      await act(() => closePanelLauncher());
      await root[Symbol.asyncDispose]();
      vi.unstubAllGlobals();
      document.body.innerHTML = "";
    },
  };
}

describe("right panel tab cycling in the panel", () => {
  it("activates the next surface on Ctrl+Tab with focus in the panel and consumes the chord", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    focusTestId("surface-focus");
    const event = await nextTab();
    expect(activated).toEqual(["diff"]);
    expect(event.defaultPrevented).toBe(true);
  });

  it("activates the previous surface on Ctrl+Shift+Tab with focus in the panel", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await render("diff");
    focusTestId("surface-focus");
    await previousTab();
    expect(activated).toEqual(["files"]);
  });

  it("wraps Ctrl+Tab from the last surface to the first and Ctrl+Shift+Tab from the first to the last", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await render("terminal");
    focusTestId("surface-focus");
    await nextTab();
    expect(activated).toEqual(["files"]);

    await render("files");
    await previousTab();
    expect(activated).toEqual(["files", "terminal"]);
  });

  it("opens the panel launcher on Ctrl+T with focus in the panel", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    focusTestId("surface-focus");
    const event = await press({ key: "t", code: "KeyT", ctrlKey: true });
    expect(launcherOpen).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(activated).toEqual([]);
  });
});

describe("right panel tab cycling outside the panel", () => {
  it("leaves Ctrl+Tab and Ctrl+Shift+Tab alone with focus in the chat", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    focusTestId("chat-focus");
    const forward = await nextTab();
    const back = await previousTab();
    expect(activated).toEqual([]);
    expect(forward.defaultPrevented).toBe(false);
    expect(back.defaultPrevented).toBe(false);
  });

  it("leaves Ctrl+Tab alone with focus on the body", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    (document.activeElement as HTMLElement | null)?.blur();
    await nextTab();
    expect(activated).toEqual([]);
  });

  it("does not open the panel launcher on Ctrl+T with focus in the chat", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    focusTestId("chat-focus");
    await press({ key: "t", code: "KeyT", ctrlKey: true });
    expect(launcherOpen).toBe(false);
  });
});

describe("right panel tab cycling launcher availability regressions", () => {
  it("retains mounted surface focus across close and opens the launcher only after reopening", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    focusTestId("surface-focus");
    await render("files", false);
    const closed = await press({ key: "t", code: "KeyT", ctrlKey: true });
    expect(launcherOpen).toBe(false);
    expect(closed.defaultPrevented).toBe(false);
    expect(document.activeElement?.getAttribute("data-testid")).toBe("surface-focus");

    await render("files", true);
    const reopened = await press({ key: "t", code: "KeyT", ctrlKey: true });
    expect(launcherOpen).toBe(true);
    expect(reopened.defaultPrevented).toBe(true);
  });

  it("defers the focused panel new-tab chord to a blocking popup until it closes", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    focusTestId("surface-focus");
    const popup = document.createElement("div");
    popup.dataset.slot = "dialog-popup";
    document.body.append(popup);
    const blocked = await press({ key: "t", code: "KeyT", ctrlKey: true });
    expect(launcherOpen).toBe(false);
    expect(blocked.defaultPrevented).toBe(false);

    popup.remove();
    const unblocked = await press({ key: "t", code: "KeyT", ctrlKey: true });
    expect(launcherOpen).toBe(true);
    expect(unblocked.defaultPrevented).toBe(true);
  });

  it("preserves terminal new-tab and tab-cycling chords with a terminal focused inside the panel", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const surface = document.querySelector<HTMLElement>("[data-testid='surface-focus']")!;
    surface.dataset.terminalOwner = "right-panel";
    surface.focus();
    const newTab = await press({ key: "t", code: "KeyT", ctrlKey: true });
    const forward = await nextTab();
    const back = await previousTab();
    expect(launcherOpen).toBe(false);
    expect(activated).toEqual([]);
    expect(newTab.defaultPrevented).toBe(false);
    expect(forward.defaultPrevented).toBe(false);
    expect(back.defaultPrevented).toBe(false);
  });
});
