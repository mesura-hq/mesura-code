// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { focusPanelSurface, setPaneEntryFocus } from "./panelSurfaceFocus";

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
