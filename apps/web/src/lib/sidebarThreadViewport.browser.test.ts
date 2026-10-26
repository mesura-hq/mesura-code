import { act, render, render as renderBrowser, type Screen } from "../../test/render";
import { createElement } from "react";
import { describe, expect, it } from "vite-plus/test";

import {
  readViewportThreadKeys,
  scrollThreadList,
  useThreadRowArrowKeys,
  useViewportThreadKeys,
} from "./sidebarThreadViewport";
import { createSidebarListMotion } from "../components/Sidebar.motion";

/**
 * A sidebar list viewport 300 high with 80-high rows at the given content
 * offsets, laid out by the browser.
 */
let fixtureContainer: HTMLDivElement;

function mountList(rows: Array<{ key: string; top: number }>, viewportWidth = 200): HTMLElement {
  const viewport = document.createElement("div");
  viewport.dataset.slot = "scroll-area-viewport";
  Object.assign(viewport.style, {
    position: "relative",
    width: `${viewportWidth}px`,
    height: "300px",
    overflowY: "auto",
  });
  viewport.scrollTo = () => {};
  const content = document.createElement("div");
  Object.assign(content.style, { position: "relative", height: "1200px" });
  for (const { key, top } of rows) {
    const row = document.createElement("div");
    row.tabIndex = 0;
    row.dataset.mesuraThreadKey = key;
    Object.assign(row.style, {
      position: "absolute",
      top: `${top}px`,
      height: "80px",
      width: "100%",
    });
    row.scrollIntoView = () => {};
    content.append(row);
  }
  viewport.append(content);
  fixtureContainer.append(viewport);
  return viewport;
}

/**
 * The sidebar's own list: a positioned `ul` in a 100px viewport, 20px rows,
 * and `createSidebarListMotion`, which animates rows to their new places and
 * fades a removed row out as an inert copy.
 */
function mountAnimatedList(keys: readonly string[]) {
  const viewport = document.createElement("div");
  viewport.dataset.slot = "scroll-area-viewport";
  Object.assign(viewport.style, { width: "200px", height: "100px", overflowY: "auto" });
  const list = document.createElement("ul");
  Object.assign(list.style, { position: "relative", margin: "0", padding: "0" });
  const rowByKey = new Map<string, HTMLLIElement>();
  for (const key of keys) {
    const item = document.createElement("li");
    Object.assign(item.style, { height: "20px", listStyle: "none" });
    const row = document.createElement("div");
    row.dataset.mesuraThreadKey = key;
    row.textContent = key;
    item.append(row);
    rowByKey.set(key, item);
    list.append(item);
  }
  viewport.append(list);
  fixtureContainer.append(viewport);
  const motion = createSidebarListMotion(list);
  motion.update(false);
  return {
    /** Puts the rows in `order`, dropping the others, and animates as the sidebar does. */
    render(order: readonly string[]) {
      for (const [key, item] of rowByKey) if (!order.includes(key)) item.remove();
      for (const key of order) list.append(rowByKey.get(key)!);
      motion.update(true);
    },
    dispose: () => motion.dispose(),
  };
}

let root: Screen | null = null;

function ArrowKeysProbe() {
  useThreadRowArrowKeys();
  return null;
}

/** Mounts `useThreadRowArrowKeys` as the sidebar does. */
async function mountArrowKeys(): Promise<void> {
  const container = document.createElement("div");
  fixtureContainer.append(container);
  root = await renderBrowser(null, { container: container, router: false });
  await act(async () => await root!.rerender(createElement(ArrowKeysProbe)));
}

/**
 * A real list, laid out by the browser: a 100px viewport with 20px rows, so
 * five rows are on screen. Prints what `useViewportThreadKeys` returns.
 */
function ViewportKeysProbe(props: {
  readonly rowKeys: readonly string[];
  readonly active: boolean;
}) {
  const keys = useViewportThreadKeys(props.active);
  return createElement(
    "div",
    null,
    createElement(
      "div",
      { "data-slot": "scroll-area-viewport", style: { height: "100px", overflowY: "auto" } },
      props.rowKeys.map((key) =>
        createElement(
          "div",
          { key, "data-mesura-thread-key": key, style: { height: "20px" } },
          key,
        ),
      ),
    ),
    createElement("output", null, keys === null ? "none" : keys.join(",")),
  );
}

describe("sidebar thread viewport", () => {
  async function setupBrowserFixture0() {
    fixtureContainer = document.createElement("div");
    document.body.append(fixtureContainer);
    return {
      async [Symbol.asyncDispose]() {
        await root?.[Symbol.asyncDispose]();
        root = null;
        fixtureContainer.remove();
      },
    };
  }

  it("numbers the rows whose middle is on screen, top to bottom", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    mountList([
      { key: "above", top: -60 },
      { key: "second", top: 100 },
      { key: "first", top: -20 },
      { key: "mostly-below", top: 270 },
      { key: "below", top: 320 },
    ]);
    expect(readViewportThreadKeys()).toEqual(["first", "second"]);
  });

  it("reads no list when the sidebar is not on screen", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    expect(readViewportThreadKeys()).toBeNull();
    mountList([{ key: "a", top: 0 }], 0);
    expect(readViewportThreadKeys()).toBeNull();
  });

  it("numbers the rows where a Ctrl+D scroll will stop, from the key press on", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

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

  it("moves focus over the rows with the arrow keys, without leaving the list", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    mountList([
      { key: "a", top: 0 },
      { key: "b", top: 100 },
      { key: "c", top: 200 },
    ]);
    await mountArrowKeys();
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
  it("moves focus over the thread rows on Up and Down without clicking a thread row", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const viewport = mountList([
      { key: "a", top: 0 },
      { key: "b", top: 100 },
      { key: "c", top: 200 },
    ]);
    const clicked: string[] = [];
    for (const row of viewport.querySelectorAll<HTMLElement>("[data-mesura-thread-key]")) {
      row.addEventListener("click", () => clicked.push(row.dataset.mesuraThreadKey ?? ""));
    }
    await mountArrowKeys();
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

  it("leaves Up and Down to a control inside a sidebar thread row", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const viewport = mountList([
      { key: "a", top: 0 },
      { key: "b", top: 100 },
    ]);
    const rename = document.createElement("input");
    viewport.querySelector('[data-mesura-thread-key="a"]')!.append(rename);
    await mountArrowKeys();

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

  it("follows the rows when they reorder, appear or disappear while the numbers show", async () => {
    // A plain list with no links: nothing here needs a router.
    await using screen = await render(
      createElement(ViewportKeysProbe, { rowKeys: ["a", "b", "c", "d", "e", "f"], active: true }),
      { router: false },
    );
    const shown = () => screen.container.querySelector("output")?.textContent;
    expect(shown()).toBe("a,b,c,d,e");

    // An agent's activity moves a thread to the top, without any scroll.
    await screen.rerender(
      createElement(ViewportKeysProbe, { rowKeys: ["d", "a", "b", "c", "e", "f"], active: true }),
    );
    expect(shown()).toBe("d,a,b,c,e");

    // A new thread appears above the others.
    await screen.rerender(
      createElement(ViewportKeysProbe, {
        rowKeys: ["new", "d", "a", "b", "c", "e", "f"],
        active: true,
      }),
    );
    expect(shown()).toBe("new,d,a,b,c");

    // A thread leaves the list.
    await screen.rerender(
      createElement(ViewportKeysProbe, { rowKeys: ["new", "a", "b", "c", "e", "f"], active: true }),
    );
    expect(shown()).toBe("new,a,b,c,e");

    await screen.rerender(
      createElement(ViewportKeysProbe, {
        rowKeys: ["new", "a", "b", "c", "e", "f"],
        active: false,
      }),
    );
    expect(shown()).toBe("none");
  });

  it("counts a row where the commit put it while the reorder animation still moves it", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    const list = mountAnimatedList(["a", "b", "c", "d", "e", "f", "g"]);
    using _motion = { [Symbol.dispose]: list.dispose };
    expect(readViewportThreadKeys()).toEqual(["a", "b", "c", "d", "e"]);

    // `g` was below the fold and moves to the top; for 150ms the animation
    // still draws it, and every row below, where it was.
    list.render(["g", "a", "b", "c", "d", "e", "f"]);
    expect(document.getAnimations().length, "precondition: the reorder animates").toBeGreaterThan(
      0,
    );
    expect(readViewportThreadKeys()).toEqual(["g", "a", "b", "c", "d"]);
  });

  it("does not count the fading copy of a removed row", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    const list = mountAnimatedList(["a", "b", "c", "d", "e", "f", "g"]);
    using _motion = { [Symbol.dispose]: list.dispose };

    list.render(["b", "c", "d", "e", "f", "g"]);
    expect(
      document.querySelectorAll('[data-mesura-thread-key="a"]').length,
      "precondition: the removed row fades out as a copy",
    ).toBe(1);
    expect(readViewportThreadKeys()).toEqual(["b", "c", "d", "e", "f"]);
  });
});
