/**
 * @vitest-environment happy-dom
 *
 * Search, driven through the composed application.
 *
 * `search.test.ts` in `fm-core` proves the arithmetic. This proves the field
 * exists, that it is MOUNTED — a whole phase of the previous cycle shipped five
 * correct components that nothing rendered — and that focus does the work the
 * cascade expects of it.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../../src/App.tsx";
import { type BridgeLog, cursorIn, installBridge, namesIn } from "./support.ts";

let log: BridgeLog;

beforeEach(() => {
  log = installBridge();
});
afterEach(cleanup);

async function opened(): Promise<void> {
  render(<App startPath="/home/jc" />);
  await waitFor(() => expect(namesIn("column-current")).toContain("projects"));
}

/** Open the search field and return it. */
async function searching(): Promise<HTMLInputElement> {
  fireEvent.keyDown(window, { key: "/", shiftKey: true });
  return (await screen.findByTestId("search-field")) as HTMLInputElement;
}

/** Type a query into the open field, as a person would. */
function type(field: HTMLInputElement, query: string): void {
  fireEvent.change(field, { target: { value: query } });
}

/** The names of the rows currently marked as matches. */
function matched(): string[] {
  return within(screen.getByTestId("column-current"))
    .queryAllByTestId("row")
    .filter((row) => row.dataset["match"] === "true")
    .map((row) => row.textContent ?? "");
}

describe("opening the search field", () => {
  it("appears on the search key and takes focus", async () => {
    await opened();
    const field = await searching();

    expect(document.activeElement).toBe(field);
  });

  it("swallows navigation keys while it holds focus", async () => {
    // Not a cascade step — the cascade's own header says so. A focused input
    // means the key never reaches the dispatcher at all, and `j` in a search
    // field is the letter j.
    await opened();
    const field = await searching();
    expect(cursorIn("column-current")).toContain("projects");

    fireEvent.keyDown(field, { key: "j" });

    expect(cursorIn("column-current")).toContain("projects");
  });
});

describe("typing a query", () => {
  it("marks every match where it sits, leaving the rest of the listing visible", async () => {
    // The decision recorded in the intent: this searches the Qt way. The whole
    // listing stays on screen, because losing the neighbours is losing most of
    // what a column is for.
    await opened();
    const field = await searching();

    type(field, "txt");

    await waitFor(() => expect(matched()).toEqual(["notes.txt", "todo.txt"]));
    expect(namesIn("column-current")).toContain("projects");
  });

  it("moves the cursor to the first match on every keystroke", async () => {
    await opened();
    const field = await searching();

    // Queries chosen so each has exactly one match and they are different rows.
    // A single letter would not do: `projects` contains a `t`, so `/t` matches
    // the row the cursor already sits on and the move would be invisible.
    type(field, "no");
    await waitFor(() => expect(cursorIn("column-current")).toContain("notes.txt"));

    type(field, "tod");
    await waitFor(() => expect(cursorIn("column-current")).toContain("todo.txt"));
  });

  it("marks nothing and moves nothing when the query matches nothing", async () => {
    await opened();
    const field = await searching();

    type(field, "zzzz");

    await waitFor(() => expect(matched()).toEqual([]));
    expect(cursorIn("column-current")).toContain("projects");
  });

  it("distinguishes a match from the cursor and from a file-operation mark", async () => {
    // Three states can coexist on one row, so they must be three attributes and
    // three classes rather than one shared highlight.
    await opened();
    const field = await searching();
    type(field, "notes");
    await waitFor(() => expect(matched()).toEqual(["notes.txt"]));

    const row = within(screen.getByTestId("column-current"))
      .getAllByTestId("row")
      .find((r) => r.textContent?.includes("notes.txt"));

    expect(row?.dataset["match"]).toBe("true");
    expect(row?.className).toContain("row--match");
    expect(row?.className).not.toContain("row--marked");
  });
});

describe("leaving the search field", () => {
  it("confirms with Enter, keeping the cursor and the marks", async () => {
    await opened();
    const field = await searching();
    type(field, "todo");
    await waitFor(() => expect(cursorIn("column-current")).toContain("todo.txt"));

    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => expect(screen.queryByTestId("search-field")).toBeNull());
    expect(cursorIn("column-current")).toContain("todo.txt");
    expect(matched()).toEqual(["todo.txt"]);
  });

  it("cancels with Escape, putting the cursor back where it started", async () => {
    // The Qt build saves the index when the field opens and restores it on
    // cancel. Leaving the cursor on a match after an abandoned search is how
    // the wrong file gets acted on next.
    await opened();
    expect(cursorIn("column-current")).toContain("projects");
    const field = await searching();
    type(field, "todo");
    await waitFor(() => expect(cursorIn("column-current")).toContain("todo.txt"));

    fireEvent.keyDown(field, { key: "Escape" });

    await waitFor(() => expect(screen.queryByTestId("search-field")).toBeNull());
    expect(cursorIn("column-current")).toContain("projects");
    expect(matched()).toEqual([]);
  });
});

describe("cycling with n and N", () => {
  async function confirmed(query: string): Promise<void> {
    await opened();
    const field = await searching();
    type(field, query);
    await waitFor(() => expect(matched().length).toBeGreaterThan(0));
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(screen.queryByTestId("search-field")).toBeNull());
  }

  it("steps forward through the matches and wraps", async () => {
    await confirmed("txt");
    expect(cursorIn("column-current")).toContain("notes.txt");

    fireEvent.keyDown(window, { key: "n" });
    await waitFor(() => expect(cursorIn("column-current")).toContain("todo.txt"));

    fireEvent.keyDown(window, { key: "n" });
    await waitFor(() => expect(cursorIn("column-current")).toContain("notes.txt"));
  });

  it("steps backward with Shift+N", async () => {
    await confirmed("txt");

    fireEvent.keyDown(window, { key: "N", shiftKey: true });
    await waitFor(() => expect(cursorIn("column-current")).toContain("todo.txt"));
  });

  it("says there is nothing to cycle when no search is running", async () => {
    // `n` is guarded in the registry by `matchCount > 0`, and a binding whose
    // guard is false does not consume its key — so this must not silently do
    // nothing either.
    await opened();

    fireEvent.keyDown(window, { key: "n" });

    expect(cursorIn("column-current")).toContain("projects");
  });
});

describe("navigating away", () => {
  it("clears the search, because the indices belonged to the old listing", async () => {
    // An index is meaningless in a different directory. The Qt `WindowState`
    // clears its transient search state on navigation for the same reason.
    await opened();
    const field = await searching();
    type(field, "txt");
    await waitFor(() => expect(matched().length).toBe(2));
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(screen.queryByTestId("search-field")).toBeNull());

    fireEvent.keyDown(window, { key: "h" });
    await waitFor(() => expect(namesIn("column-current")).toContain("jc"));

    expect(matched()).toEqual([]);
  });
});

describe("a confirmed search survives the listing changing under it", () => {
  /**
   * Push a new first entry from the main process, and wait for it to LAND.
   *
   * The wait is two steps and both are needed. `waitFor` proves the new listing
   * reached the DOM; the empty `act` then flushes the effect that recomputes the
   * search position from it. Without the second step this raced — the keypress
   * below arrived before the effect committed and the test failed roughly one
   * run in three, which is worse than no test at all.
   */
  async function refresh(name: string): Promise<void> {
    log.addEntryFirst("/home/jc", name);
    for (const id of log.watched) log.emitChange(id);
    await waitFor(() => expect(namesIn("column-current")).toContain(name));
    await act(async () => undefined);
  }

  /** Search, confirm, and step once so the position is not at its start. */
  async function confirmedAndStepped(): Promise<void> {
    await opened();
    const field = await searching();
    type(field, "txt");
    await waitFor(() => expect(matched()).toEqual(["notes.txt", "todo.txt"]));
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(screen.queryByTestId("search-field")).toBeNull());

    fireEvent.keyDown(window, { key: "n" });
    await waitFor(() => expect(cursorIn("column-current")).toContain("todo.txt"));
  }

  it("steps from where the cursor IS after the indices shift underneath it", async () => {
    // The defect this pins, and the shape of it matters. The position `n` steps
    // from was tracked only while the FIELD was open, so a confirmed search went
    // stale the moment a watcher refresh shifted the listing's indices — and a
    // new entry sorting BEFORE the cursor shifts every index after it.
    //
    // The failure is not a crash and not an exception: `nextMatch` takes its
    // result modulo the match count, so a stale position always lands somewhere
    // valid. It lands on the match the cursor is ALREADY on. The user presses
    // `n` and nothing happens, which reads as a broken key rather than as
    // state that drifted.
    await confirmedAndStepped();

    await refresh("aaa.txt");
    // The cursor followed its NAME, as `setEntries` promises; its INDEX moved.
    expect(cursorIn("column-current")).toContain("todo.txt");

    fireEvent.keyDown(window, { key: "n" });

    // Steps to the next match rather than back onto todo.txt.
    await waitFor(() => expect(cursorIn("column-current")).toContain("aaa.txt"));
  });

  it("does not drag the cursor when the refresh arrives", async () => {
    // The other half of the same effect: once confirmed, the user is navigating
    // with `n`. A background event must keep the position honest WITHOUT moving
    // them somewhere they did not ask to go.
    await confirmedAndStepped();

    await refresh("aaa.txt");

    expect(cursorIn("column-current")).toContain("todo.txt");
  });
});
