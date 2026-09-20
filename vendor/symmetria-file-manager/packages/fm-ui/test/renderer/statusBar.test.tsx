/**
 * @vitest-environment happy-dom
 *
 * One bar at the bottom, and nothing above it that comes and goes.
 *
 * ── Why every assertion here is STRUCTURAL ──────────────────────────────────
 * The property is "the columns do not move", and happy-dom has no layout engine
 * — every `getBoundingClientRect` reads zero whatever the stylesheet says. So
 * what is checked is the thing that CAUSES the movement: whether an element is
 * inserted into or removed from the window's own stack. Nothing entering or
 * leaving `.app` is the honest form of "nothing moved", and it is a stronger
 * claim than a pixel comparison against a fake layout would be.
 *
 * The height itself is a token, pinned in `theme.test.ts`.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../../src/App.tsx";
import { installBridge, namesIn } from "./support.ts";

beforeEach(() => {
  installBridge();
});
afterEach(cleanup);

const FIFO = "/tmp/fake.fifo";

async function opened(picker = false): Promise<void> {
  render(
    picker ? (
      <App
        startPath="/home/jc"
        homePath="/home/jc"
        picker={{
          fifo: FIFO,
          options: {
            title: "Select a File",
            acceptLabel: "",
            multiple: false,
            directory: false,
            saveMode: false,
            suggestedName: "",
            currentFolder: "",
          },
        }}
      />
    ) : (
      <App startPath="/home/jc" homePath="/home/jc" />
    ),
  );
  await waitFor(() => expect(namesIn("column-current").length).toBeGreaterThan(0));
  await act(async () => undefined);
}

/** The window's own stack. Anything joining or leaving it moves the columns. */
function stack(): string[] {
  const app = document.querySelector(".app");
  return [...(app?.children ?? [])].map((child) => child.className);
}

function press(key: string, init: Partial<KeyboardEventInit> = {}): void {
  fireEvent.keyDown(window, { key, ...init });
}

describe("the window's stack does not change", () => {
  it("is the same with the search field open as with it closed", async () => {
    await opened();
    const before = stack();

    press("/", { shiftKey: true });
    await screen.findByTestId("search-field");

    // The search field used to be a row of its own above the columns, so
    // opening it pushed the whole listing down and closing it let it spring
    // back — under the eyes of somebody trying to find a file.
    expect(stack()).toEqual(before);
  });

  it("is the same again after the search closes", async () => {
    await opened();
    const before = stack();

    press("/", { shiftKey: true });
    const field = await screen.findByTestId("search-field");
    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("search-field")).toBeNull());

    expect(stack()).toEqual(before);
  });

  it("is the same when the render-mode indicator appears", async () => {
    // The indicator joins the STATUS BAR's contents, never the window's stack.
    // It began as a badge drawn over the preview and moved here at the
    // operator's request; a version that added a row of its own instead would
    // push the columns down exactly as the search field used to.
    await opened();
    const before = stack();

    press("l");
    await waitFor(() => expect(namesIn("column-current")).toContain("beta.md"));
    press("j");
    await screen.findByTestId("status-render-mode");

    expect(stack()).toEqual(before);
  });

  it("is the same again after Ctrl+R changes which mode it names", async () => {
    await opened();
    press("l");
    await waitFor(() => expect(namesIn("column-current")).toContain("beta.md"));
    press("j");
    await screen.findByTestId("status-render-mode");
    const before = stack();

    press("r", { ctrlKey: true });
    await waitFor(() =>
      expect(screen.getByTestId("status-render-mode").textContent).toMatch(/source/i),
    );

    expect(stack()).toEqual(before);
  });

  it("is the same while a message is showing", async () => {
    await opened();
    const before = stack();

    press("y");
    press("y");
    await screen.findByTestId("pane-message");

    expect(stack()).toEqual(before);
  });
});

describe("what the bar shows, in order of precedence", () => {
  it("gives the whole bar to the search field", async () => {
    await opened();

    press("/", { shiftKey: true });
    await screen.findByTestId("search-field");

    const bar = screen.getByTestId("status-bar");
    expect(bar.querySelector('[data-testid="search-field"]')).not.toBeNull();
    // The counts step aside rather than sharing the row: the operator asked to
    // "just replace everything and put the search there".
    expect(bar.textContent).not.toContain("sort:");
  });

  it("shows a message instead of the counts, and the counts again after", async () => {
    await opened();
    expect(screen.getByTestId("status-bar").textContent).toContain("sort:");

    press("y");
    press("y");
    const message = await screen.findByTestId("pane-message");

    expect(screen.getByTestId("status-bar").contains(message)).toBe(true);
    expect(screen.getByTestId("status-bar").textContent).not.toContain("sort:");
  });
});

describe("the bar in a file dialog", () => {
  it("hides Accept and Cancel while the search has it, and gives them back", async () => {
    await opened(true);
    expect(screen.getByTestId("picker-accept")).toBeTruthy();

    press("/", { shiftKey: true });
    const field = await screen.findByTestId("search-field");

    // The operator chose this over crowding the row: search takes the bar over
    // and Escape brings the dialog's own controls back.
    expect(screen.queryByTestId("picker-accept")).toBeNull();
    expect(screen.queryByTestId("picker-cancel")).toBeNull();

    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() => expect(screen.getByTestId("picker-accept")).toBeTruthy());
  });

  it("does not change the dialog's stack either", async () => {
    await opened(true);
    const before = stack();

    press("/", { shiftKey: true });
    await screen.findByTestId("search-field");

    expect(stack()).toEqual(before);
  });
});

describe("the search field still owns the keyboard", () => {
  it("takes focus when it opens", async () => {
    await opened();

    press("/", { shiftKey: true });
    const field = await screen.findByTestId("search-field");

    expect(document.activeElement).toBe(field);
  });

  it("takes a letter as a letter, not as a cursor move", async () => {
    // `useKeyDispatch` reports a focused input as a text input and the cascade
    // answers `notOurs` for every key. Moving the field must not change that,
    // and the bar must gain no other focusable control that could swallow `j`.
    await opened();
    const cursorBefore = document.querySelector(
      '[data-testid="column-current"] [data-cursor="true"]',
    )?.textContent;

    press("/", { shiftKey: true });
    // SAFETY: `findByTestId` is typed `HTMLElement`, and only an input carries
    // `value`. The element is the `<input>` `SearchField` renders under that
    // id, so the cast narrows to what the DOM already holds.
    const field = (await screen.findByTestId("search-field")) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "j" } });

    expect(field.value).toBe("j");
    expect(
      document.querySelector('[data-testid="column-current"] [data-cursor="true"]')?.textContent,
    ).toBe(cursorBefore);
  });
});

/**
 * An error belongs to the tab whose listing failed.
 *
 * Verification found the bar still showing one tab's failure after switching to
 * another — pre-existing, and this phase made it worse because the message now
 * hides the counts instead of sitting beside them in a row of its own.
 *
 * The first repair cleared the error on every switch, and that broke the other
 * direction: coming BACK to the failing tab showed "0 entries" with nothing to
 * say why, because returning to a tab that already has a recorded listing does
 * not re-attempt the read. Both directions are asserted here for that reason —
 * the first fix passed one of them.
 */
describe("a failed listing belongs to its own tab", () => {
  /** Open a second tab and take it somewhere that will not list. */
  async function twoTabsOneBroken(): Promise<void> {
    await opened();
    press("t");
    await waitFor(() => expect(screen.getAllByTestId("tab").length).toBe(2));
    // And WAIT for the new tab's own listing. The tab bar appears before the
    // column does, so walking the cursor here found an empty column when the
    // renderer suites ran together and their timers competed.
    await waitFor(() =>
      expect(namesIn("column-current").some((name) => name.includes("locked"))).toBe(true),
    );

    // `locked` is in the home listing and absent from the fixture's tree, so
    // entering it fails the way an unreadable directory does.
    //
    // Scoped to the CURRENT column: `getAllByTestId("row")` spans the parent
    // column and the preview too, and an index counted across all three walks
    // the cursor to the wrong entry.
    const locked = namesIn("column-current").findIndex((name) => name.includes("locked"));
    expect(locked).toBeGreaterThan(-1);
    for (let i = 0; i < locked; i++) press("j");
    press("l");

    await screen.findByTestId("pane-error");
  }

  it("hides it on the tab that did not fail", async () => {
    await twoTabsOneBroken();

    press("[");

    await waitFor(() => expect(screen.queryByTestId("pane-error")).toBeNull());
    expect(screen.getByTestId("status-bar").textContent).toContain("sort:");
  });

  it("shows it again on the tab that did", async () => {
    await twoTabsOneBroken();
    press("[");
    await waitFor(() => expect(screen.queryByTestId("pane-error")).toBeNull());

    press("]");

    // The half the first repair got wrong. Clearing on a switch wiped this too,
    // and the directory then read as an ordinary empty one.
    await waitFor(() => expect(screen.getByTestId("pane-error")).toBeTruthy());
  });
});
