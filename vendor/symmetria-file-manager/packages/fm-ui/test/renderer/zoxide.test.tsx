/**
 * @vitest-environment happy-dom
 *
 * Jumping to a directory zoxide already knows you visit.
 *
 * `z` opens a list, typing narrows it, Enter goes there. What is proved here is
 * the interface: the list is asked for once when the popup opens and filtered
 * in the renderer, so typing costs nothing. Reading zoxide's output is proved
 * in the shared package, and spawning it is proved against the real binary.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../../src/App.tsx";
import { type BridgeLog, installBridge, namesIn } from "./support.ts";

let log: BridgeLog;

beforeEach(() => {
  log = installBridge();
});
afterEach(cleanup);

async function opened(at = "/home/jc"): Promise<void> {
  render(<App startPath={at} homePath="/home/jc" />);
  await waitFor(() => expect(namesIn("column-current").length).toBeGreaterThan(0));
  await act(async () => undefined);
}

function press(key: string, init: Partial<KeyboardEventInit> = {}): void {
  fireEvent.keyDown(window, { key, ...init });
}

/** The rows the popup is showing, in order. */
function rows(): string[] {
  return within(screen.getByTestId("zoxide"))
    .queryAllByTestId("zoxide-row")
    .map((row) => row.textContent ?? "");
}

/**
 * A key pressed while the popup has the keyboard.
 *
 * Dispatched at the FIELD, not at the window, because that is where a real one
 * arrives: the field takes focus when the popup opens, so the event starts
 * there and bubbles. Dispatching at the window instead skips the popup's
 * handler entirely and tests nothing.
 */
function pressInPopup(key: string): void {
  fireEvent.keyDown(screen.getByTestId("zoxide-query"), { key });
}

/** Type into the popup's field. */
function type(text: string): void {
  const field = screen.getByTestId("zoxide-query");
  fireEvent.change(field, { target: { value: text } });
}

async function zoxideOpen(): Promise<void> {
  press("z");
  await waitFor(() => expect(screen.queryByTestId("zoxide")).not.toBeNull());
  await act(async () => undefined);
}

describe("opening the list", () => {
  it("shows what zoxide knows, most frecent first", async () => {
    await opened();

    await zoxideOpen();

    expect(rows().some((row) => row.includes("/home/jc/Downloads"))).toBe(true);
    expect(rows()[0]).toContain("/home/jc/Downloads");
  });

  it("asks zoxide once, not once per keystroke", async () => {
    // The whole list is fetched on open and narrowed in the renderer. Querying
    // per keystroke would spawn a process per character.
    await opened();
    await zoxideOpen();
    const asked = log.ops.filter((op) => op === "zoxide").length;

    type("wo");
    type("wor");
    type("work");
    await act(async () => undefined);

    expect(log.ops.filter((op) => op === "zoxide")).toHaveLength(asked);
  });
});

describe("narrowing and choosing", () => {
  it("keeps only the paths that contain what was typed", async () => {
    await opened();
    await zoxideOpen();

    type("sales");

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toContain("/home/jc/work/sales/bambin");
  });

  it("goes to the highlighted directory on Enter, and closes", async () => {
    await opened();
    await zoxideOpen();
    type("sales");
    await waitFor(() => expect(rows()).toHaveLength(1));

    pressInPopup("Enter");

    await waitFor(() => expect(log.listed).toContain("/home/jc/work/sales/bambin"));
    expect(screen.queryByTestId("zoxide")).toBeNull();
  });

  it("moves the highlight with the arrow keys", async () => {
    await opened();
    await zoxideOpen();

    pressInPopup("ArrowDown");

    await waitFor(() => {
      const active = screen.getByTestId("zoxide").querySelector('[data-active="true"]');
      expect(active?.textContent).toContain("/home/jc/work/sales/bambin");
    });
  });
});

describe("leaving without choosing", () => {
  it("closes on Escape and navigates nowhere", async () => {
    await opened();
    const before = [...log.listed];
    await zoxideOpen();

    pressInPopup("Escape");

    await waitFor(() => expect(screen.queryByTestId("zoxide")).toBeNull());
    expect(log.listed).toEqual(before);
  });

  it("returns the keyboard to the pane afterwards", async () => {
    // The popup consumes every key while it is up, so leaving it has to
    // actually leave it — otherwise the next `j` is typed into a field that is
    // no longer on screen.
    await opened();
    await zoxideOpen();
    pressInPopup("Escape");
    await waitFor(() => expect(screen.queryByTestId("zoxide")).toBeNull());

    press("j");

    await waitFor(() =>
      expect(
        screen.getByTestId("column-current").querySelector('[data-cursor="true"]')?.textContent,
      ).toContain("notes.txt"),
    );
  });
});

describe("the popup can always be closed", () => {
  it("closes on an Escape that did not go to the field", async () => {
    // Review found the popup could get STUCK. Its handler is a prop on the
    // field, so it fires only while the field has focus — and Tab moved focus
    // off it. After that no handler ran, the cascade's modal step swallowed
    // every key without closing anything, and the popup could not be dismissed
    // by keyboard at all.
    //
    // A window-level Escape is the backstop, and this presses one that never
    // touches the field.
    await opened();
    await zoxideOpen();

    press("Escape");

    await waitFor(() => expect(screen.queryByTestId("zoxide")).toBeNull());
  });

  it("keeps the keyboard when Tab is pressed, rather than losing it", async () => {
    await opened();
    await zoxideOpen();

    const tab = fireEvent.keyDown(screen.getByTestId("zoxide-query"), { key: "Tab" });

    // The event was cancelled, so focus does not move to whatever is next.
    expect(tab).toBe(false);
    expect(screen.queryByTestId("zoxide")).not.toBeNull();
  });
});

describe("when zoxide is not there", () => {
  it("opens and says so, rather than showing an empty list", async () => {
    // An empty list and a missing binary look identical, and the second is
    // something the user can fix. Saying which is the difference.
    log.failNextZoxide("zoxide is not installed");
    await opened();

    await zoxideOpen();

    expect(screen.getByTestId("zoxide").textContent).toMatch(/not installed/i);
  });
});

describe("the movement keys the overlay list shares", () => {
  it("moves the highlight with Ctrl+J and Ctrl+K as well as with the arrows", async () => {
    // Gained when the keyboard logic was extracted into `useOverlayList` so
    // that this dialog and the file finder cannot drift apart on it. Asserted
    // HERE because a change made for the finder's sake would otherwise be free
    // to take these bindings away from this one and break nothing visible.
    await opened();
    await zoxideOpen();

    fireEvent.keyDown(screen.getByTestId("zoxide-query"), { key: "j", ctrlKey: true });
    await waitFor(() => {
      const active = screen.getByTestId("zoxide").querySelector('[data-active="true"]');
      expect(active?.textContent).toContain("/home/jc/work/sales/bambin");
    });

    // Paired with the move down, so a handler that ignored both keys could not
    // pass by leaving the highlight where it started.
    fireEvent.keyDown(screen.getByTestId("zoxide-query"), { key: "k", ctrlKey: true });
    await waitFor(() => {
      const active = screen.getByTestId("zoxide").querySelector('[data-active="true"]');
      expect(active?.textContent).not.toContain("/home/jc/work/sales/bambin");
    });
  });
});
