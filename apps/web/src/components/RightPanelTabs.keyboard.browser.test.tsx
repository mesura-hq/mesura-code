// Entry point: RightPanelTabs, including its retained empty state and both launcher key handlers.

import { type ComponentProps, type ReactNode } from "react";
import { act, render, fakeTimers, type Screen } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
} from "@t3tools/shared/keybindings";

import { ACTIVE_TAB_TITLE_SELECTOR } from "~/lib/panelSurfaceFocus";
import { closePanelLauncher, usePanelLauncherOpen } from "~/lib/panelLauncher";

import { registerCommandHandlers } from "~/commands/commandRegistry";
import { toastManager } from "~/components/ui/toast";

import { RightPanelTabs } from "./RightPanelTabs";

vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
const browserDefaults = vi.hoisted(() => ({ profiles: [] as { id: string; name: string }[] }));
vi.mock("~/browser/browserDefaults", () => ({ useBrowserDefaults: () => browserDefaults }));

let root: Screen;
let container: HTMLDivElement;
const addFiles = vi.fn();
const noop = () => undefined;

async function setupBrowserFixture0() {
  const _timers = fakeTimers();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  addFiles.mockClear();
  browserDefaults.profiles = [];
  container = document.createElement("div");
  document.body.append(container);
  root = await render(null, { container, router: false });

  return {
    async [Symbol.asyncDispose]() {
      closePanelLauncher();
      await root[Symbol.asyncDispose]();
      container.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      _timers[Symbol.dispose]();
    },
  };
}

function panelElement(overrides: Partial<ComponentProps<typeof RightPanelTabs>> = {}) {
  return (
    <RightPanelTabs
      mode="inline"
      open
      keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
      getShortcutContext={() => ({
        terminalFocus: false,
        terminalOpen: false,
        previewFocus: false,
        previewOpen: false,
        isWeb: true,
        isDesktop: false,
      })}
      surfaces={[{ id: "files", kind: "files" }]}
      environmentId={null}
      activeSurfaceId="files"
      pendingProjectKey={null}
      previewSessions={{}}
      desktopByTabId={{}}
      terminalLabelsById={new Map()}
      onActivate={noop}
      onCloseSurface={noop}
      onCloseOtherSurfaces={noop}
      onCloseSurfacesToRight={noop}
      onCloseAllSurfaces={noop}
      onCopyFilePath={noop}
      onAddBrowser={noop}
      onAddBrowserInProfile={noop}
      onAddTerminal={noop}
      onAddDiff={noop}
      onAddFiles={addFiles}
      onAddPullRequest={noop}
      onAddPullRequests={noop}
      onAddDevice={noop}
      browserAvailable={false}
      terminalAvailable={false}
      diffAvailable={false}
      filesAvailable
      pullRequestAvailable={false}
      pullRequestsAvailable={false}
      deviceAvailable={false}
      {...overrides}
    >
      content
    </RightPanelTabs>
  );
}

function LauncherStateProbe() {
  const open = usePanelLauncherOpen();
  return <output data-testid="launcher-state">{open ? "open" : "closed"}</output>;
}

const launcherState = () => container.querySelector('[data-testid="launcher-state"]')?.textContent;

async function renderPanels(content: ReactNode) {
  await act(() =>
    root.rerender(
      <>
        <LauncherStateProbe />
        {content}
      </>,
    ),
  );
  await act(() => vi.advanceTimersByTimeAsync(0));
  await act(() => vi.advanceTimersToNextFrame());
}

async function renderPanel(overrides: Partial<ComponentProps<typeof RightPanelTabs>> = {}) {
  await renderPanels(panelElement(overrides));
}

async function press(key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  await act(() => (document.activeElement ?? document.body).dispatchEvent(event));
  await act(() => vi.advanceTimersByTimeAsync(0));
  await act(() => vi.advanceTimersToNextFrame());
  return event;
}

describe("right panel new-tab shortcut", () => {
  it.each(["MacIntel", "Win32", "Linux x86_64"])(
    "opens the launcher on %s and chooses a tab",
    async (platform) => {
      await using _browserFixture0 = await setupBrowserFixture0();

      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      await renderPanel();
      const event = await press(
        "t",
        platform === "MacIntel" ? { metaKey: true } : { ctrlKey: true },
      );
      expect(event.defaultPrevented).toBe(true);
      expect(document.querySelector('[aria-label="Open a surface"]')?.textContent).toContain(
        "Linked pull requests",
      );
      expect(document.activeElement?.closest('[aria-label="Open a surface"]')).not.toBeNull();
      expect(
        (
          await press("t", {
            metaKey: platform === "MacIntel",
            ctrlKey: platform !== "MacIntel",
            repeat: true,
          })
        ).defaultPrevented,
      ).toBe(true);
      await press("f");
      expect(addFiles).toHaveBeenCalledOnce();
      expect(document.querySelector('[aria-label="Open a surface"]')).toBeNull();
    },
  );

  it("right panel launcher regression: unmount after opening releases the new-tab shortcut", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await renderPanel();
    await press("t", { metaKey: true });
    expect(document.querySelector('[aria-label="Open a surface"]')).not.toBeNull();
    expect(launcherState()).toBe("open");
    await renderPanels(null);
    expect(launcherState()).toBe("closed");
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    await renderPanel();
    expect(launcherState()).toBe("closed");
    expect(document.querySelector('[aria-label="Open a surface"]')).toBeNull();
  });

  it("right panel launcher regression: closing a rerendered panel releases the new-tab shortcut", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await renderPanel();
    await press("t", { metaKey: true });
    await renderPanel({ open: false });
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
  });

  it("right panel launcher regression: a focused closed panel preserves browser new-tab keys after repeated choices", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    for (let iteration = 0; iteration < 3; iteration++) {
      await renderPanel();
      await press("t", { metaKey: true });
      await press("f");
      await act(() => root.rerender(null));
    }
    await renderPanel({ open: false });
    const panelTab = container.querySelector<HTMLElement>(ACTIVE_TAB_TITLE_SELECTOR);
    expect(panelTab).not.toBeNull();
    await act(() => panelTab!.focus());
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
  });

  it("leaves the shortcut alone while the mounted panel is closed", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await renderPanel({ open: false });
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    expect(document.querySelector('[aria-label="Open a surface"]')).toBeNull();
  });

  it.each(["Win32", "Linux x86_64"])(
    "leaves Ctrl+T for the focused terminal on %s",
    async (platform) => {
      await using _browserFixture0 = await setupBrowserFixture0();

      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      await renderPanel({
        getShortcutContext: () => ({
          terminalFocus: true,
          terminalOpen: true,
          previewFocus: false,
          previewOpen: false,
          isWeb: true,
          isDesktop: false,
        }),
      });
      const terminal = document.createElement("textarea");
      const onKeyDown = vi.fn();
      terminal.addEventListener("keydown", onKeyDown);
      container.append(terminal);
      await act(() => terminal.focus());
      const event = await press("t", { ctrlKey: true });
      expect(event.defaultPrevented).toBe(false);
      expect(onKeyDown).toHaveBeenCalledWith(event);
      expect(document.querySelector('[aria-label="Open a surface"]')).toBeNull();
    },
  );

  it("uses a custom binding from a text field and closes on Escape", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const input = document.createElement("input");
    await renderPanel({
      keybindings: compileResolvedKeybindingsConfig([{ key: "mod+y", command: "rightPanel.new" }]),
    });
    document.body.append(input);
    input.focus();
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    await press("y", { metaKey: true });
    expect(document.querySelector('[aria-label="Open a surface"]')).not.toBeNull();
    await press("Escape");
    expect(document.querySelector('[aria-label="Open a surface"]')).toBeNull();
    // The launcher returns focus to the field that opened it.
    expect(document.activeElement).toBe(input);
    input.remove();
  });

  it("does not open over another popup or during text composition", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await renderPanel();
    expect((await press("t", { metaKey: true, isComposing: true })).defaultPrevented).toBe(false);
    const dialog = document.createElement("div");
    dialog.dataset.slot = "dialog-popup";
    container.append(dialog);
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    expect(document.querySelector('[aria-label="Open a surface"]')).toBeNull();
  });

  it("supports arrow keys with an existing tab in sheet mode and clears the launcher on close", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const panel = {
      mode: "sheet" as const,
      surfaces: [{ id: "files" as const, kind: "files" as const }],
    };
    await renderPanel(panel);
    await press("t", { metaKey: true });
    await press("ArrowDown");
    await press("ArrowDown");
    await press("ArrowDown");
    expect(document.activeElement?.textContent).toContain("Files");
    await press("Enter");
    expect(addFiles).toHaveBeenCalledOnce();
    await press("t", { metaKey: true });
    await renderPanel({ ...panel, open: false });
    expect(document.querySelector('[aria-label="Open a surface"]')).toBeNull();
    await renderPanel(panel);
    expect(document.querySelector('[aria-label="Open a surface"]')).toBeNull();
  });
});

describe("panel launcher review regressions", () => {
  it.each([
    { mode: "sheet", activation: "letter" },
    { mode: "sheet", activation: "Enter" },
    { mode: "sheet", activation: "native button" },
    { mode: "inline", activation: "letter" },
  ] as const)(
    "parks keyboard focus before first surface activation in $mode via $activation",
    async ({ mode, activation }) => {
      await using _browserFixture0 = await setupBrowserFixture0();

      let focusAtActivation: Element | null = null;
      const activate = vi.fn(() => {
        focusAtActivation = document.activeElement;
      });
      await renderPanel({ mode, surfaces: [], activeSurfaceId: null, onAddFiles: activate });
      const content = container.querySelector<HTMLElement>("[data-right-panel-surface-content]")!;
      if (activation === "letter") await press("f");
      else if (activation === "Enter") {
        await press("ArrowDown");
        await press("Enter");
      } else {
        const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
          (node) => node.textContent === "FilesF",
        )!;
        await act(() => button.focus());
        await press("Enter");
        await act(() =>
          button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })),
        );
      }
      expect(activate).toHaveBeenCalledOnce();
      expect(focusAtActivation).toBe(content);
      expect(content.tabIndex).toBe(-1);
      expect(content.isContentEditable).not.toBe(true);
    },
  );

  it.each([0, 1])(
    "preserves pointer focus on first launcher activation with click detail %s",
    async (detail) => {
      await using _browserFixture0 = await setupBrowserFixture0();

      let focusAtActivation: Element | null = null;
      const activate = vi.fn(() => {
        focusAtActivation = document.activeElement;
      });
      await renderPanel({ surfaces: [], activeSurfaceId: null, onAddFiles: activate });
      const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (node) => node.textContent === "FilesF",
      )!;
      await act(() => button.focus());
      await act(() => button.dispatchEvent(new Event("pointerdown", { bubbles: true })));
      await act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail })));
      expect(activate).toHaveBeenCalledOnce();
      expect(focusAtActivation).toBe(button);
    },
  );

  it("parks focus for Base UI browser-profile keyboard activation before the launcher is removed", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    browserDefaults.profiles = [
      { id: "synthetic-one", name: "Synthetic first profile" },
      { id: "synthetic-two", name: "Synthetic second profile" },
    ];
    let focusAtActivation: Element | null = null;
    const activate = vi.fn(() => {
      focusAtActivation = document.activeElement;
    });
    await renderPanel({
      mode: "sheet",
      surfaces: [],
      activeSurfaceId: null,
      browserAvailable: true,
      onAddBrowserInProfile: activate,
    });
    const content = container.querySelector<HTMLElement>("[data-right-panel-surface-content]")!;
    const chooser = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open browser in a profile"]',
    )!;
    await act(() => chooser.click());
    await act(() => vi.advanceTimersByTimeAsync(0));
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (node) => node.textContent === "Synthetic second profile",
    )!;
    await act(() => item.focus());
    await press("Enter");
    expect(activate).toHaveBeenCalledWith("synthetic-two");
    expect(focusAtActivation).toBe(content);
  });

  it("retains native keyboard handoff when another mounted panel disposes its input listener", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    let focusAtActivation: Element | null = null;
    const activate = vi.fn(() => {
      focusAtActivation = document.activeElement;
    });
    const first = (
      <section key="first">{panelElement({ surfaces: [], activeSurfaceId: null })}</section>
    );
    const second = (
      <section key="second">
        {panelElement({ surfaces: [], activeSurfaceId: null, onAddFiles: activate })}
      </section>
    );
    await renderPanels([first, second]);
    await act(() => window.dispatchEvent(new Event("pointerdown")));
    await renderPanels([second]);
    const content = container.querySelector<HTMLElement>("[data-right-panel-surface-content]")!;
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === "FilesF",
    )!;
    await act(() => button.focus());
    await press("Enter");
    await act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    expect(activate).toHaveBeenCalledOnce();
    expect(focusAtActivation).toBe(content);
  });

  it.each(["inline", "sheet"] as const)(
    "panel launcher P1-1: a retained empty %s panel ignores letters and navigation while closed and restores them on reopen",
    async (mode) => {
      await using _browserFixture0 = await setupBrowserFixture0();

      const toggle = vi.fn();
      const dispose = registerCommandHandlers({ "rightPanel.toggle": toggle });
      const notice = vi.spyOn(toastManager, "add");
      const empty = { mode, surfaces: [], activeSurfaceId: null };
      try {
        await renderPanel(empty);
        const launcher = container.querySelector<HTMLElement>('[aria-label="Open a surface"]')!;
        expect(launcher).not.toBeNull();
        await press("ArrowDown");
        await renderPanel({ ...empty, open: false });
        expect(container.querySelector('[aria-label="Open a surface"]')).toBe(launcher);
        await act(() => launcher.focus());
        for (const key of ["f", "o", "z", "ArrowDown", "Enter", "Escape"]) {
          expect((await press(key)).defaultPrevented).toBe(false);
        }
        expect(addFiles).not.toHaveBeenCalled();
        expect(toggle).not.toHaveBeenCalled();
        expect(notice).not.toHaveBeenCalled();
        await renderPanel(empty);
        expect(container.querySelector('[aria-label="Open a surface"]')).toBe(launcher);
        expect((await press("f")).defaultPrevented).toBe(true);
        expect(addFiles).toHaveBeenCalledOnce();
      } finally {
        dispose();
      }
    },
  );

  it("panel launcher P1-2: inline to phone-sheet handoff retains the launcher only with an open replacement", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await renderPanels(<section key="inline">{panelElement()}</section>);
    await press("t", { metaKey: true });
    expect(launcherState()).toBe("open");
    await renderPanels(<section key="sheet">{panelElement({ mode: "sheet" })}</section>);
    expect(launcherState()).toBe("open");
    expect(
      container.querySelector('[data-preview-panel-mode="sheet"] [aria-label="Open a surface"]'),
    ).not.toBeNull();
    await press("f");
    expect(addFiles).toHaveBeenCalledOnce();
    expect(launcherState()).toBe("closed");

    await press("t", { metaKey: true });
    await renderPanels(<section key="closed-inline">{panelElement({ open: false })}</section>);
    expect(launcherState()).toBe("closed");
    await renderPanels(<section key="closed-inline">{panelElement()}</section>);
    expect(container.querySelector('[aria-label="Open a surface"]')).toBeNull();
  });

  it("panel launcher P1-2: closing and removing a second mounted panel cannot clear the first panel owner", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const panels = (second: "open" | "closed" | "absent") => (
      <>
        <section key="owner" data-testid="owner">
          {panelElement()}
        </section>
        {second !== "absent" ? (
          <section key="other" data-testid="other">
            {panelElement({ open: second === "open" })}
          </section>
        ) : null}
      </>
    );
    await renderPanels(panels("open"));
    const owner = container.querySelector('[data-testid="owner"]')!;
    const other = container.querySelector('[data-testid="other"]')!;
    await act(() =>
      owner.querySelector<HTMLButtonElement>('[aria-label="Add panel surface"]')!.click(),
    );
    expect(launcherState()).toBe("open");
    expect(owner.querySelector('[aria-label="Open a surface"]')).not.toBeNull();
    expect(other.querySelector('[aria-label="Open a surface"]')).toBeNull();
    await renderPanels(panels("closed"));
    expect(launcherState()).toBe("open");
    expect(owner.querySelector('[aria-label="Open a surface"]')).not.toBeNull();
    await renderPanels(panels("absent"));
    expect(launcherState()).toBe("open");
    await press("f");
    expect(addFiles).toHaveBeenCalledOnce();
    expect(launcherState()).toBe("closed");
  });

  it("panel launcher P1-2: removal of the owner closes its launcher without transferring it to an existing unrelated panel", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await renderPanels(
      <>
        <section key="owner" data-testid="owner">
          {panelElement()}
        </section>
        <section key="other" data-testid="other">
          {panelElement()}
        </section>
      </>,
    );
    await act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="owner"] [aria-label="Add panel surface"]')!
        .click(),
    );
    expect(launcherState()).toBe("open");
    await renderPanels(
      <>
        <section key="other" data-testid="other">
          {panelElement()}
        </section>
      </>,
    );
    expect(launcherState()).toBe("closed");
    expect(container.querySelector('[aria-label="Open a surface"]')).toBeNull();
  });
});
