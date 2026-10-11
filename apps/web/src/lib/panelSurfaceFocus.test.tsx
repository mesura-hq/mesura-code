// @vitest-environment happy-dom
// Entry points: `focusPanelSurface` (`panelSurfaceFocus.ts`), and
// `usePanelSurfaceKeys` mounted beside `useRightPanelTabCycling` in a panel
// harness, as `RightPanelTabs` mounts them: a real `Ctrl+Tab` keydown changes
// the active surface, and the specs read where focus lands. happy-dom lays
// nothing out and runs no frames, so boxes are stubbed and
// `requestAnimationFrame` runs from a queue the specs flush.
import { act, useLayoutEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    function (this: HTMLElement) {
      const shown = !hidden.has(this);
      return { length: shown ? 1 : 0 } as DOMRectList;
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  hidden.clear();
  document.body.innerHTML = "";
});

describe("panel surface focus", () => {
  it("focuses the highest-ranked entry the surface shows, not a toolbar button", () => {
    const panel = mountPanel(`
      <button data-testid="refresh">Refresh</button>
      <div data-pane-entry="1" data-testid="tree" tabindex="-1"></div>
      <div data-pane-entry="2" data-testid="editor" tabindex="-1"></div>`);
    expect(focusPanelSurface(panel)).toBe(true);
    expect(document.activeElement).toBe(byTestId("editor"));
  });

  it("skips an entry that is not shown", () => {
    const panel = mountPanel(`
      <div data-pane-entry="1" data-testid="tree" tabindex="-1"></div>
      <div data-pane-entry="2" data-testid="editor" tabindex="-1"></div>`);
    hidden.add(byTestId("editor"));
    expect(focusPanelSurface(panel)).toBe(true);
    expect(document.activeElement).toBe(byTestId("tree"));
  });

  it("focuses an entry's scroll region, so the arrows scroll it", () => {
    const panel = mountPanel(`
      <div data-pane-entry="2"><div><div data-testid="scroller" style="overflow-y: auto"></div></div></div>`);
    expect(focusPanelSurface(panel)).toBe(true);
    expect(document.activeElement).toBe(byTestId("scroller"));
    expect(byTestId("scroller").tabIndex).toBe(-1);
  });

  it("focuses the shown scroll region past a hidden one, as a pull request's inactive tab is", () => {
    const panel = mountPanel(`
      <div data-pane-entry="1">
        <div style="visibility: hidden"><div data-testid="summary" style="overflow-y: auto"></div></div>
        <div><div data-testid="timeline" style="overflow-y: auto"></div></div>
      </div>`);
    expect(focusPanelSurface(panel)).toBe(true);
    expect(document.activeElement).toBe(byTestId("timeline"));
  });

  it("reports a surface still loading its scroll region as not ready", () => {
    const panel = mountPanel(`<div data-pane-entry="2"><p>Loading…</p></div>`);
    expect(focusPanelSurface(panel)).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it("uses an entry's own focus when it names one", () => {
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

let harnessRoot: Root | null = null;
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

function mountHarness(): void {
  document.body.innerHTML = `
    <div data-chat-column-maximized-away="false">
      <div data-testid="chat-focus" tabindex="0"></div>
    </div>
    <div data-testid="panel-host"></div>`;
  harnessRoot = createRoot(byTestId("panel-host"));
  act(() => harnessRoot!.render(<PanelHarness />));
  // Whether the last input was a key is module state that outlives a spec:
  // each spec starts from a pointer, and the mount's own focus follow is
  // dropped, so only the spec's own input moves focus.
  act(() => {
    window.dispatchEvent(new Event("pointerdown"));
  });
  frames = [];
}

function flushFrames(): void {
  for (let guard = 0; frames.length > 0 && guard < 100; guard++) {
    const due = frames;
    frames = [];
    act(() => {
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

function pressFrom(target: Element, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

const pressCtrlTab = () =>
  pressFrom(document.activeElement ?? document.body, { key: "Tab", code: "Tab", ctrlKey: true });

describe("panel surface focus follows a key", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  });

  afterEach(() => {
    act(() => harnessRoot?.unmount());
    harnessRoot = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("lands focus on the new surface's highest-ranked entry after Ctrl+Tab changes the surface", () => {
    mountHarness();
    byTestId("files-tree").focus();
    pressCtrlTab();
    flushFrames();
    expect(document.activeElement).toBe(byTestId("diff-view"));
  });

  it("leaves focus where it was when a pointer changes the active surface", () => {
    mountHarness();
    byTestId("title-files").focus();
    // The tap: a pointerdown, then the tab's click handler activates it.
    act(() => {
      byTestId("title-diff").dispatchEvent(new Event("pointerdown", { bubbles: true }));
      activate("diff");
    });
    flushFrames();
    expect(document.activeElement).toBe(byTestId("title-files"));
    expect(byTestId("diff-view")).toBeTruthy();
  });

  /**
   * `Ctrl+Tab` to a Diff surface still loading: its entry has no scroll
   * region yet, so focus parks on its tab title and the wait begins.
   */
  function parkOnLoadingDiff(): void {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    surfaceMarkup.diff = `<div data-pane-entry="2" data-testid="diff-loading"><p>Loading…</p></div>`;
    mountHarness();
    byTestId("files-tree").focus();
    pressCtrlTab();
    flushFrames();
    expect(document.activeElement).toBe(byTestId("title-diff"));
  }

  /** The Diff entry's scroll region renders, and its frames run. */
  async function renderLateDiffEntry(): Promise<void> {
    byTestId("diff-loading").insertAdjacentHTML(
      "beforeend",
      '<div data-testid="diff-scroller" style="overflow-y: auto"></div>',
    );
    await flushMutations();
    flushFrames();
  }

  it("parks focus on the active tab title until a late entry renders, then focuses the entry", async () => {
    parkOnLoadingDiff();
    vi.advanceTimersByTime(3999);
    await renderLateDiffEntry();
    expect(document.activeElement).toBe(byTestId("diff-scroller"));
  });

  it("stops waiting for a late entry after 4 s, leaving focus on the tab title", async () => {
    parkOnLoadingDiff();
    vi.advanceTimersByTime(4000);
    await renderLateDiffEntry();
    expect(document.activeElement).toBe(byTestId("title-diff"));
  });

  it("stops waiting for a late entry when focus moves elsewhere meanwhile", async () => {
    parkOnLoadingDiff();
    byTestId("chat-focus").focus();
    await renderLateDiffEntry();
    expect(document.activeElement).toBe(byTestId("chat-focus"));
  });

  it("stops waiting for a late entry when focus leaves the tab title and comes back before it renders", async () => {
    parkOnLoadingDiff();
    byTestId("chat-focus").focus();
    byTestId("title-diff").focus();
    await renderLateDiffEntry();
    expect(document.activeElement).toBe(byTestId("title-diff"));
  });

  it("waits for a late entry after a pane move into the panel too (Ctrl+L)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // A Files tree still loading after a reload: its entry has no scroll region yet.
    surfaceMarkup.files = `<div data-pane-entry="1" data-testid="files-loading"><p>Loading…</p></div>`;
    mountHarness();
    byTestId("chat-focus").focus();

    act(() => {
      expect(enterPanel()).toBe(true);
    });
    expect(document.activeElement).toBe(byTestId("title-files"));

    byTestId("files-loading").insertAdjacentHTML(
      "beforeend",
      '<div data-testid="files-scroller" style="overflow-y: auto"></div>',
    );
    await flushMutations();
    flushFrames();
    expect(document.activeElement).toBe(byTestId("files-scroller"));
  });

  it("keeps waiting for a late entry when focus drops from the tab title to the body", async () => {
    parkOnLoadingDiff();
    byTestId("title-diff").blur();
    expect(document.activeElement).toBe(document.body);
    await renderLateDiffEntry();
    expect(document.activeElement).toBe(byTestId("diff-scroller"));
  });
});

describe("panel surface half-page keys", () => {
  let scrollBy: ReturnType<typeof vi.fn>;

  /** A surface whose region scrolls: 1000 of content in a 400-high box. */
  function mountScrollingSurface(inner: string): HTMLElement {
    surfaceMarkup.files = `
      <div data-pane-entry="1" data-testid="region" style="overflow-y: auto" tabindex="-1">${inner}</div>`;
    mountHarness();
    const region = byTestId("region");
    Object.defineProperty(region, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(region, "clientHeight", { configurable: true, value: 400 });
    region.scrollBy = scrollBy as unknown as HTMLElement["scrollBy"];
    return region;
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);
    scrollBy = vi.fn();
  });

  afterEach(() => {
    act(() => harnessRoot?.unmount());
    harnessRoot = null;
    vi.unstubAllGlobals();
  });

  const ctrl = (key: string) => ({ key, code: `Key${key.toUpperCase()}`, ctrlKey: true });

  it("scrolls a focused panel scroll region half its height on Ctrl+D and Ctrl+U", () => {
    const region = mountScrollingSurface("");
    region.focus();
    const down = pressFrom(region, ctrl("d"));
    const up = pressFrom(region, ctrl("u"));
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

  for (const [name, inner] of leftAlone) {
    it(`leaves Ctrl+D and Ctrl+U to ${name} inside a panel scroll region`, () => {
      mountScrollingSurface(inner);
      const target = byTestId("target");
      target.focus();
      const down = pressFrom(target, ctrl("d"));
      const up = pressFrom(target, ctrl("u"));
      expect(scrollBy).not.toHaveBeenCalled();
      expect(down.defaultPrevented).toBe(false);
      expect(up.defaultPrevented).toBe(false);
    });
  }

  it("leaves Ctrl+D to a panel surface that took it first", () => {
    const region = mountScrollingSurface("");
    region.addEventListener("keydown", (event) => event.preventDefault());
    region.focus();
    pressFrom(region, ctrl("d"));
    expect(scrollBy).not.toHaveBeenCalled();
  });
});
