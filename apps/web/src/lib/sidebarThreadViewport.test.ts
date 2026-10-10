// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  readViewportThreadKeys,
  scrollThreadList,
  useThreadRowArrowKeys,
} from "./sidebarThreadViewport";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function box(top: number, height: number, width = 200): DOMRect {
  return { top, bottom: top + height, height, width, left: 0, right: width } as DOMRect;
}

/**
 * A sidebar list viewport 300 high with 80-high rows at the given content
 * offsets; each row's box follows the viewport's `scrollTop`, as layout would.
 */
function mountList(rows: Array<{ key: string; top: number }>, viewportWidth = 200): HTMLElement {
  const viewport = document.createElement("div");
  viewport.dataset.slot = "scroll-area-viewport";
  viewport.getBoundingClientRect = () => box(0, 300, viewportWidth);
  Object.defineProperty(viewport, "clientHeight", { value: 300 });
  Object.defineProperty(viewport, "scrollHeight", { value: 1200 });
  viewport.scrollTo = () => {};
  for (const { key, top } of rows) {
    const row = document.createElement("div");
    row.tabIndex = 0;
    row.dataset.mesuraThreadKey = key;
    row.getBoundingClientRect = () => box(top - viewport.scrollTop, 80);
    row.scrollIntoView = () => {};
    viewport.append(row);
  }
  document.body.append(viewport);
  return viewport;
}

let root: Root | null = null;

function ArrowKeysProbe() {
  useThreadRowArrowKeys();
  return null;
}

/** Mounts `useThreadRowArrowKeys` as the sidebar does. */
function mountArrowKeys(): void {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(createElement(ArrowKeysProbe)));
}

describe("sidebar thread viewport", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  it("numbers the rows whose middle is on screen, top to bottom", () => {
    mountList([
      { key: "above", top: -60 },
      { key: "second", top: 100 },
      { key: "first", top: -20 },
      { key: "mostly-below", top: 270 },
      { key: "below", top: 320 },
    ]);
    expect(readViewportThreadKeys()).toEqual(["first", "second"]);
  });

  it("reads no list when the sidebar is not on screen", () => {
    expect(readViewportThreadKeys()).toBeNull();
    mountList([{ key: "a", top: 0 }], 0);
    expect(readViewportThreadKeys()).toBeNull();
  });

  it("numbers the rows where a Ctrl+D scroll will stop, from the key press on", () => {
    mountList(
      Array.from({ length: 12 }, (_, index) => ({ key: `row-${index}`, top: index * 100 })),
    );
    expect(readViewportThreadKeys()?.[0]).toBe("row-0");
    // Half the 300-high viewport: the scroll has not moved yet.
    scrollThreadList("down");
    expect(readViewportThreadKeys()?.[0]).toBe("row-2");
    // A second press before the first settles continues from its target.
    scrollThreadList("down");
    expect(readViewportThreadKeys()?.[0]).toBe("row-3");
    scrollThreadList("up");
    scrollThreadList("up");
    expect(readViewportThreadKeys()?.[0]).toBe("row-0");
  });

  it("moves focus over the rows with the arrow keys, without leaving the list", () => {
    mountList([
      { key: "a", top: 0 },
      { key: "b", top: 100 },
      { key: "c", top: 200 },
    ]);
    mountArrowKeys();
    const focused = () => (document.activeElement as HTMLElement | null)?.dataset.mesuraThreadKey;
    const press = (key: string) =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key, cancelable: true }));

    // Focus outside the list: the arrows are not the list's.
    press("ArrowDown");
    expect(focused()).toBeUndefined();

    document.querySelector<HTMLElement>('[data-mesura-thread-key="a"]')!.focus();
    press("ArrowDown");
    expect(focused()).toBe("b");
    press("ArrowDown");
    press("ArrowDown");
    expect(focused()).toBe("c");
    press("ArrowUp");
    expect(focused()).toBe("b");
  });

  // What a row does with a key is `Sidebar.tsx`'s own handler, which this
  // fixture does not copy; this pins only that the hook moves focus without
  // clicking a row, which is how a row opens its thread.
  it("moves focus over the thread rows on Up and Down without clicking a thread row", () => {
    const viewport = mountList([
      { key: "a", top: 0 },
      { key: "b", top: 100 },
      { key: "c", top: 200 },
    ]);
    const clicked: string[] = [];
    for (const row of viewport.querySelectorAll<HTMLElement>("[data-mesura-thread-key]")) {
      row.addEventListener("click", () => clicked.push(row.dataset.mesuraThreadKey ?? ""));
    }
    mountArrowKeys();
    const pressOnFocused = (key: string) => {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      (document.activeElement ?? document.body).dispatchEvent(event);
      return event;
    };
    const focused = () => (document.activeElement as HTMLElement | null)?.dataset.mesuraThreadKey;

    document.querySelector<HTMLElement>('[data-mesura-thread-key="c"]')!.focus();
    const up = pressOnFocused("ArrowUp");
    expect(focused()).toBe("b");
    expect(up.defaultPrevented).toBe(true);
    pressOnFocused("ArrowUp");
    expect(focused()).toBe("a");
    // The first row is the list's top: Up stays there.
    pressOnFocused("ArrowUp");
    expect(focused()).toBe("a");
    pressOnFocused("ArrowDown");
    expect(focused()).toBe("b");
    expect(clicked).toEqual([]);
  });

  it("leaves Up and Down to a control inside a sidebar thread row", () => {
    const viewport = mountList([
      { key: "a", top: 0 },
      { key: "b", top: 100 },
    ]);
    const rename = document.createElement("input");
    viewport.querySelector('[data-mesura-thread-key="a"]')!.append(rename);
    mountArrowKeys();

    rename.focus();
    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    rename.dispatchEvent(event);
    expect(document.activeElement).toBe(rename);
    expect(event.defaultPrevented).toBe(false);
  });
});
