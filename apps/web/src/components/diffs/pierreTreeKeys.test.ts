// @vitest-environment happy-dom
// Entry point: `usePierreTreePaneEntry` (`pierreTreeKeys.ts`), bound to a
// tree wrapper the way `DiffFileTree` binds it, reached through
// `focusPanelSurface` as every keyboard way into the panel reaches it. The
// tree is a fake `FileTree` whose container holds an open shadow root with
// Pierre's row buttons and virtualized scroller; like Pierre, it moves the
// roving `tabindex="0"` to the row that takes focus. happy-dom lays nothing
// out, so every row's box is stubbed from its index.
import type { FileTree } from "@pierre/trees";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { focusPanelSurface } from "~/lib/panelSurfaceFocus";

import { usePierreTreePaneEntry } from "./pierreTreeKeys";

const ROW_HEIGHT = 40;
const SCROLLER_HEIGHT = 400;
const ROW_COUNT = 10;

let root: Root;
let shadow: ShadowRoot;
let rows: HTMLButtonElement[];

function box(top: number, height: number): DOMRect {
  return { top, bottom: top + height, height, width: 200, left: 0, right: 200 } as DOMRect;
}

/** A Pierre tree scrolled to its end: `scrollTop` stays where it is. */
function fakeTree(rovingIndex: number): FileTree {
  const host = document.createElement("div");
  shadow = host.attachShadow({ mode: "open" });
  const scroller = document.createElement("div");
  scroller.setAttribute("data-file-tree-virtualized-scroll", "");
  scroller.getBoundingClientRect = () => box(0, SCROLLER_HEIGHT);
  Object.defineProperty(scroller, "clientHeight", { value: SCROLLER_HEIGHT });
  Object.defineProperty(scroller, "scrollTop", { get: () => 0, set: () => {} });
  rows = Array.from({ length: ROW_COUNT }, (_, index) => {
    const row = document.createElement("button");
    row.dataset.itemPath = `src/file-${index}.ts`;
    row.tabIndex = index === rovingIndex ? 0 : -1;
    row.getBoundingClientRect = () => box(index * ROW_HEIGHT, ROW_HEIGHT);
    scroller.append(row);
    return row;
  });
  shadow.append(scroller);
  // Pierre's roving tabindex follows the focused row.
  shadow.addEventListener("focusin", (event) => {
    for (const row of rows) row.tabIndex = row === event.target ? 0 : -1;
  });
  return { getFileTreeContainer: () => host } as unknown as FileTree;
}

function TreeWrapper({ model }: { model: FileTree }) {
  const { bind, onKeyDown } = usePierreTreePaneEntry(model);
  return createElement("div", {
    "data-pane-entry": "1",
    ref: (element: HTMLDivElement | null) => {
      const unbind = bind(element);
      if (element) element.append(model.getFileTreeContainer()!);
      return unbind;
    },
    onKeyDown,
  });
}

function mount(rovingIndex: number): Element {
  document.body.innerHTML = `
    <div data-preview-panel-mode="inline">
      <div data-right-panel-surface-content data-testid="content"></div>
    </div>`;
  root = createRoot(document.querySelector('[data-testid="content"]')!);
  act(() => root.render(createElement(TreeWrapper, { model: fakeTree(rovingIndex) })));
  return document.querySelector("[data-preview-panel-mode]")!;
}

/**
 * A keydown from the focused row, as the page sees it: a browser retargets an
 * event leaving a shadow root to the shadow host, and React finds its
 * handler from that target. happy-dom does not retarget, so the event is
 * dispatched from the host the browser would report.
 */
function pressCtrl(key: "d" | "u"): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    code: `Key${key.toUpperCase()}`,
    ctrlKey: true,
    bubbles: true,
    composed: true,
    cancelable: true,
  });
  act(() => {
    expect(shadow.activeElement).not.toBeNull();
    shadow.host.dispatchEvent(event);
  });
  return event;
}

const focusedRowIndex = () => rows.indexOf(shadow.activeElement as HTMLButtonElement);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    () => ({ length: 1 }) as DOMRectList,
  );
});

afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("pierre tree pane entry", () => {
  it("focuses the Pierre tree's roving row when the panel surface takes focus", () => {
    const panel = mount(3);
    expect(focusPanelSurface(panel)).toBe(true);
    expect(focusedRowIndex()).toBe(3);
  });

  it("focuses the Pierre tree's first row when no row holds the roving tabindex", () => {
    const panel = mount(-1);
    expect(focusPanelSurface(panel)).toBe(true);
    expect(focusedRowIndex()).toBe(0);
  });
});

describe("pierre tree half-page keys at the end of the list", () => {
  it("moves the Pierre tree focus half a page of rows on Ctrl+D and Ctrl+U when the list cannot scroll", () => {
    const panel = mount(2);
    focusPanelSurface(panel);
    // Half of 400 over 40-high rows: five rows a step.
    const down = pressCtrl("d");
    expect(focusedRowIndex()).toBe(7);
    expect(down.defaultPrevented).toBe(true);

    pressCtrl("d");
    expect(focusedRowIndex()).toBe(ROW_COUNT - 1);

    pressCtrl("u");
    expect(focusedRowIndex()).toBe(4);
    pressCtrl("u");
    pressCtrl("u");
    expect(focusedRowIndex()).toBe(0);
  });

  it("leaves Ctrl+D alone while no Pierre tree row has focus", () => {
    mount(2);
    const event = new KeyboardEvent("keydown", {
      key: "d",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.querySelector("[data-pane-entry]")!.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(shadow.activeElement).toBeNull();
  });
});
