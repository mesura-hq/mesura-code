import { act, render as renderBrowser, type Screen, fakeTimers } from "../../test/render";
// Entry points: `focusPanelSurface` (`panelSurfaceFocus.ts`), and
// `usePanelSurfaceKeys` mounted beside `useRightPanelTabCycling` in a panel
// harness, as `RightPanelTabs` mounts them: a real `Ctrl+Tab` keydown changes
// the active surface, and the specs read where focus lands. happy-dom lays
// nothing out and runs no frames, so boxes are stubbed and
// `requestAnimationFrame` runs from a queue the specs flush.
import { useLayoutEffect, useRef, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  enterPanel,
  focusPanelSurface,
  setPaneEntryFocus,
  usePanelSurfaceKeys,
} from "./panelSurfaceFocus";
import { useRightPanelTabCycling } from "./rightPanelTabCycling";

/** A surface in a panel; happy-dom lays nothing out, so each test says what shows. */
function mountPanel(surface: string): Element {
  document.body.innerHTML = `
    <div data-preview-panel-mode="inline">
      <div data-right-panel-tabbar>
        <div data-active-tab="true"><button data-testid="title">Files</button></div>
      </div>
      <div data-right-panel-surface-content>${surface}</div>
    </div>`;
  return document.querySelector("[data-preview-panel-mode]")!;
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const hidden = new Set<Element>();

async function setupBrowserFixture0() {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (
    this: HTMLElement,
  ) {
    const shown = !hidden.has(this);
    return { length: shown ? 1 : 0 } as DOMRectList;
  });

  return {
    async [Symbol.asyncDispose]() {
      vi.restoreAllMocks();
      hidden.clear();
      document.body.innerHTML = "";
    },
  };
}

describe("panel surface focus", () => {
  it("focuses the highest-ranked entry the surface shows, not a toolbar button", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const panel = mountPanel(`
      <button data-testid="refresh">Refresh</button>
      <div data-pane-entry="1" data-testid="tree" tabindex="-1"></div>
      <div data-pane-entry="2" data-testid="editor" tabindex="-1"></div>`);
    expect(focusPanelSurface(panel)).toBe(true);
    expect(document.activeElement).toBe(byTestId("editor"));
  });

  it("skips an entry that is not shown", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const panel = mountPanel(`
      <div data-pane-entry="1" data-testid="tree" tabindex="-1"></div>
      <div data-pane-entry="2" data-testid="editor" tabindex="-1"></div>`);
    hidden.add(byTestId("editor"));
    expect(focusPanelSurface(panel)).toBe(true);
    expect(document.activeElement).toBe(byTestId("tree"));
  });

  it("focuses an entry's scroll region, so the arrows scroll it", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const panel = mountPanel(`
      <div data-pane-entry="2"><div><div data-testid="scroller" style="overflow-y: auto"></div></div></div>`);
    expect(focusPanelSurface(panel)).toBe(true);
    expect(document.activeElement).toBe(byTestId("scroller"));
    expect(byTestId("scroller").tabIndex).toBe(-1);
  });

  it("focuses the shown scroll region past a hidden one, as a pull request's inactive tab is", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const panel = mountPanel(`
      <div data-pane-entry="1">
        <div style="visibility: hidden"><div data-testid="summary" style="overflow-y: auto"></div></div>
        <div><div data-testid="timeline" style="overflow-y: auto"></div></div>
      </div>`);
    expect(focusPanelSurface(panel)).toBe(true);
    expect(document.activeElement).toBe(byTestId("timeline"));
  });

  it("reports a surface still loading its scroll region as not ready", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const panel = mountPanel(`<div data-pane-entry="2"><p>Loading…</p></div>`);
    expect(focusPanelSurface(panel)).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it("uses an entry's own focus when it names one", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const panel = mountPanel(`<div data-pane-entry="1" data-testid="pierre"></div>`);
    const row = document.createElement("button");
    byTestId("pierre").append(row);
    setPaneEntryFocus(byTestId("pierre"), () => {
      row.focus();
      return true;
    });
    expect(focusPanelSurface(panel)).toBe(true);
    expect(document.activeElement).toBe(row);
  });
});

// ── The panel harness ──────────────────────────────────────────────────────

/** Each surface's content markup; a spec swaps one in to model a late render. */
const surfaceMarkup: Record<string, string> = {};
const SURFACE_IDS = ["files", "diff"] as const;

let harnessRoot: Screen | null = null;
let activate: (id: string) => void = () => {};
let frames: FrameRequestCallback[] = [];

function PanelHarness() {
  const [activeId, setActiveId] = useState<string>("files");
  useLayoutEffect(() => {
    activate = setActiveId;
  });
  const panelRef = useRef<HTMLDivElement | null>(null);
  const tabBarRef = useRef<HTMLDivElement | null>(null);
  usePanelSurfaceKeys(panelRef, activeId);
  useRightPanelTabCycling({
    tabBarRef,
    surfaces: SURFACE_IDS.map((id) => ({ id })),
    activeSurfaceId: activeId,
    onActivate: (surface) => setActiveId(surface.id),
  });
  return (
    <div data-preview-panel-mode="inline" ref={panelRef}>
      <div data-right-panel-tabbar="" ref={tabBarRef}>
        {SURFACE_IDS.map((id) => (
          <div key={id} data-active-tab={String(id === activeId)}>
            <button data-testid={`title-${id}`}>{id}</button>
          </div>
        ))}
      </div>
      <div
        key={activeId}
        data-right-panel-surface-content=""
        dangerouslySetInnerHTML={{ __html: surfaceMarkup[activeId] ?? "" }}
      />
    </div>
  );
}

async function mountHarness(): Promise<void> {
  document.body.innerHTML = `
    <div data-chat-column-maximized-away="false">
      <div data-testid="chat-focus" tabindex="0"></div>
    </div>
    <div data-testid="panel-host"></div>`;
  harnessRoot = await renderBrowser(null, { container: byTestId("panel-host"), router: false });
  await act(async () => await harnessRoot!.rerender(<PanelHarness />));
  // Whether the last input was a key is module state that outlives a spec:
  // each spec starts from a pointer, and the mount's own focus follow is
  // dropped, so only the spec's own input moves focus.
  await act(() => {
    window.dispatchEvent(new Event("pointerdown"));
  });
  frames = [];
}

async function flushFrames(): Promise<void> {
  for (let guard = 0; frames.length > 0 && guard < 100; guard++) {
    const due = frames;
    frames = [];
    await act(() => {
      for (const callback of due) callback(0);
    });
  }
}

/** Lets happy-dom deliver its MutationObserver records, which it queues as microtasks. */
async function flushMutations(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function pressFrom(target: Element, init: KeyboardEventInit): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

const pressCtrlTab = async () =>
  await pressFrom(document.activeElement ?? document.body, {
    key: "Tab",
    code: "Tab",
    ctrlKey: true,
  });

describe("panel surface focus follows a key", () => {
  async function setupBrowserFixture1() {
    frames = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    surfaceMarkup.files = `<div data-pane-entry="1" data-testid="files-tree" tabindex="-1"></div>`;
    surfaceMarkup.diff = `
      <button data-testid="diff-toolbar">Refresh</button>
      <div data-pane-entry="1" data-testid="diff-list" tabindex="-1"></div>
      <div data-pane-entry="2" data-testid="diff-view" tabindex="-1"></div>`;

    return {
      async [Symbol.asyncDispose]() {
        await harnessRoot?.[Symbol.asyncDispose]();
        harnessRoot = null;
        vi.useRealTimers();
        vi.unstubAllGlobals();
      },
    };
  }

  it("lands focus on the new surface's highest-ranked entry after Ctrl+Tab changes the surface", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await using _browserFixture1 = await setupBrowserFixture1();

    await mountHarness();
    byTestId("files-tree").focus();
    await pressCtrlTab();
    await flushFrames();
    expect(document.activeElement).toBe(byTestId("diff-view"));
  });

  it("preserves a user focus move before the pending surface handoff's first frame", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await using _browserFixture1 = await setupBrowserFixture1();

    await mountHarness();
    byTestId("files-tree").focus();
    await pressCtrlTab();
    byTestId("chat-focus").focus();
    await flushFrames();
    expect(document.activeElement).toBe(byTestId("chat-focus"));
  });

  it("leaves focus where it was when a pointer changes the active surface", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await using _browserFixture1 = await setupBrowserFixture1();

    await mountHarness();
    byTestId("title-files").focus();
    // The tap: a pointerdown, then the tab's click handler activates it.
    await act(() => {
      byTestId("title-diff").dispatchEvent(new Event("pointerdown", { bubbles: true }));
      activate("diff");
    });
    await flushFrames();
    expect(document.activeElement).toBe(byTestId("title-files"));
    expect(byTestId("diff-view")).toBeTruthy();
  });

  /**
   * `Ctrl+Tab` to a Diff surface still loading: its entry has no scroll
   * region yet, so focus parks on its tab title and the wait begins.
   */
  async function parkOnLoadingDiff(): Promise<void> {
    using _timers = fakeTimers();
    surfaceMarkup.diff = `<div data-pane-entry="2" data-testid="diff-loading"><p>Loading…</p></div>`;
    await mountHarness();
    byTestId("files-tree").focus();
    await pressCtrlTab();
    await flushFrames();
    expect(document.activeElement).toBe(byTestId("title-diff"));
  }

  /** The Diff entry's scroll region renders, and its frames run. */
  async function renderLateDiffEntry(): Promise<void> {
    byTestId("diff-loading").insertAdjacentHTML(
      "beforeend",
      '<div data-testid="diff-scroller" style="overflow-y: auto"></div>',
    );
    await flushMutations();
    await flushFrames();
  }

  it("parks focus on the active tab title until a late entry renders, then focuses the entry", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await using _browserFixture1 = await setupBrowserFixture1();

    await parkOnLoadingDiff();
    vi.advanceTimersByTime(3999);
    await renderLateDiffEntry();
    expect(document.activeElement).toBe(byTestId("diff-scroller"));
  });

  it("stops waiting for a late entry after 4 s, leaving focus on the tab title", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await using _browserFixture1 = await setupBrowserFixture1();

    await parkOnLoadingDiff();
    vi.advanceTimersByTime(4000);
    await renderLateDiffEntry();
    expect(document.activeElement).toBe(byTestId("title-diff"));
  });

  it("stops waiting for a late entry when focus moves elsewhere meanwhile", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await using _browserFixture1 = await setupBrowserFixture1();

    await parkOnLoadingDiff();
    byTestId("chat-focus").focus();
    await renderLateDiffEntry();
    expect(document.activeElement).toBe(byTestId("chat-focus"));
  });

  it("cancels lazy keyboard entry focus on pointer input that keeps the current focus", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await using _browserFixture1 = await setupBrowserFixture1();

    await parkOnLoadingDiff();
    byTestId("title-diff").dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await renderLateDiffEntry();
    expect(document.activeElement).toBe(byTestId("title-diff"));
  });

  it("stops waiting for a late entry when focus leaves the tab title and comes back before it renders", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await using _browserFixture1 = await setupBrowserFixture1();

    await parkOnLoadingDiff();
    byTestId("chat-focus").focus();
    byTestId("title-diff").focus();
    await renderLateDiffEntry();
    expect(document.activeElement).toBe(byTestId("title-diff"));
  });

  it("waits for a late entry after a pane move into the panel too (Ctrl+L)", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await using _browserFixture1 = await setupBrowserFixture1();

    using _timers = fakeTimers();
    // A Files tree still loading after a reload: its entry has no scroll region yet.
    surfaceMarkup.files = `<div data-pane-entry="1" data-testid="files-loading"><p>Loading…</p></div>`;
    await mountHarness();
    byTestId("chat-focus").focus();

    await act(() => {
      expect(enterPanel()).toBe(true);
    });
    expect(document.activeElement).toBe(byTestId("title-files"));

    byTestId("files-loading").insertAdjacentHTML(
      "beforeend",
      '<div data-testid="files-scroller" style="overflow-y: auto"></div>',
    );
    await flushMutations();
    await flushFrames();
    expect(document.activeElement).toBe(byTestId("files-scroller"));
  });

  it("keeps waiting for a late entry when focus drops from the tab title to the body", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await using _browserFixture1 = await setupBrowserFixture1();

    await parkOnLoadingDiff();
    byTestId("title-diff").blur();
    expect(document.activeElement).toBe(document.body);
    await renderLateDiffEntry();
    expect(document.activeElement).toBe(byTestId("diff-scroller"));
  });
});

describe("panel surface half-page keys", () => {
  let scrollBy: ReturnType<typeof vi.fn>;

  /** A surface whose region scrolls: 1000 of content in a 400-high box. */
  async function mountScrollingSurface(inner: string): Promise<HTMLElement> {
    surfaceMarkup.files = `
      <div data-pane-entry="1" data-testid="region" style="overflow-y: auto" tabindex="-1">${inner}</div>`;
    await mountHarness();
    const region = byTestId("region");
    Object.defineProperty(region, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(region, "clientHeight", { configurable: true, value: 400 });
    region.scrollBy = scrollBy as unknown as HTMLElement["scrollBy"];
    return region;
  }

  async function setupBrowserFixture2() {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);
    scrollBy = vi.fn();

    return {
      async [Symbol.asyncDispose]() {
        await harnessRoot?.[Symbol.asyncDispose]();
        harnessRoot = null;
        vi.unstubAllGlobals();
      },
    };
  }

  const ctrl = (key: string) => ({ key, code: `Key${key.toUpperCase()}`, ctrlKey: true });

  it("scrolls a focused panel scroll region half its height on Ctrl+D and Ctrl+U", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await using _browserFixture2 = await setupBrowserFixture2();

    const region = await mountScrollingSurface("");
    region.focus();
    const down = await pressFrom(region, ctrl("d"));
    const up = await pressFrom(region, ctrl("u"));
    expect(scrollBy.mock.calls.map(([options]) => (options as ScrollToOptions).top)).toEqual([
      200, -200,
    ]);
    expect(down.defaultPrevented).toBe(true);
    expect(up.defaultPrevented).toBe(true);
  });

  const leftAlone: ReadonlyArray<readonly [string, string]> = [
    ["a text input", '<input data-testid="target" />'],
    [
      "the terminal",
      '<div class="xterm"><textarea class="xterm-helper-textarea" data-testid="target"></textarea></div>',
    ],
    [
      "the editor",
      '<div class="monaco-editor"><textarea class="inputarea" data-testid="target"></textarea></div>',
    ],
  ];

  it.each(leftAlone)(
    "leaves Ctrl+D and Ctrl+U to %s inside a panel scroll region",
    async (_name, inner) => {
      await using _browserFixture0 = await setupBrowserFixture0();
      await using _browserFixture2 = await setupBrowserFixture2();

      await mountScrollingSurface(inner);
      const target = byTestId("target");
      target.focus();
      const down = await pressFrom(target, ctrl("d"));
      const up = await pressFrom(target, ctrl("u"));
      expect(scrollBy).not.toHaveBeenCalled();
      expect(down.defaultPrevented).toBe(false);
      expect(up.defaultPrevented).toBe(false);
    },
  );

  it("leaves Ctrl+D to a panel surface that took it first", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await using _browserFixture2 = await setupBrowserFixture2();

    const region = await mountScrollingSurface("");
    region.addEventListener("keydown", (event) => event.preventDefault());
    region.focus();
    await pressFrom(region, ctrl("d"));
    expect(scrollBy).not.toHaveBeenCalled();
  });
});
