/**
 * @vitest-environment happy-dom
 *
 * Flash jump, driven through the real window listener.
 *
 * `flashLabels.test.ts` and `flashSession.test.ts` prove the engine and the key
 * table against fixtures. This proves the application is WIRED to them — the
 * class of gap that left the registry's `s` row pointing at a stub for five
 * phases while every unit test passed.
 *
 * ── The fixture's labels, derived once ──────────────────────────────────────
 * The home listing is projects · notes.txt · todo.txt · empty · locked · many,
 * and the cursor starts on `projects`.
 *
 * A query of "n" matches `notes.txt` (at 0) and `many` (at 2). The characters
 * that follow those are `o` and `y`, and the query's own `n` goes too, so the
 * pool loses o · y · n and hands out `a` then `s` — in cursor-distance order,
 * which puts `notes.txt` first.
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

/** The rows of the current column, in listing order. */
function rows(): HTMLElement[] {
  return within(screen.getByTestId("column-current")).getAllByTestId("row");
}

/** What one row's name reads as on screen, labels and all. */
function nameAt(index: number): string {
  return rows()[index]?.querySelector(".row__name")?.textContent ?? "";
}

/** Which row the cursor is on, by position rather than by name. */
function cursorRow(): number {
  return rows().findIndex((row) => row.dataset["cursor"] === "true");
}

/** The flash state of each row: "match", "dim", or absent. */
function flashStates(): (string | undefined)[] {
  return rows().map((row) => row.dataset["flash"]);
}

/** Start a session and type, one key at a time, as the user would. */
function press(...keys: readonly string[]): void {
  for (const key of keys) fireEvent.keyDown(window, { key });
}

describe("starting a session", () => {
  it("shows the indicator and the query as it is typed", async () => {
    await opened();

    press("s");
    await waitFor(() => expect(screen.getByTestId("status-flash")).toBeTruthy());

    press("n");
    await waitFor(() => expect(screen.getByTestId("status-flash").textContent).toContain("n"));
  });

  it("no longer reports that flash jump is not built", async () => {
    await opened();

    press("s");

    await waitFor(() => expect(screen.getByTestId("status-flash")).toBeTruthy());
    expect(screen.getByTestId("status-bar").textContent).not.toContain("not built yet");
  });
});

describe("labelling", () => {
  it("labels every matching row of the current column", async () => {
    await opened();

    press("s", "n");

    // notes.txt is row 1 and many is row 5; both carry a label, and the
    // labelled rows are exactly the matching ones.
    await waitFor(() => expect(flashStates()[1]).toBe("match"));
    expect(flashStates()).toEqual(["dim", "match", "dim", "dim", "dim", "match"]);
  });

  it("overtypes the characters after the match with the label", async () => {
    await opened();

    press("s", "n");

    // "notes.txt" keeps its "n", the label "a" replaces the "o", and the rest
    // of the name follows: n · a · tes.txt.
    await waitFor(() => expect(nameAt(1)).toBe("nates.txt"));
    // "many" matches at index 2, so "ma" survives, "n" is the match, and the
    // label "s" replaces the "y".
    expect(nameAt(5)).toBe("mans");
  });

  it("marks the matched characters apart from the label", async () => {
    await opened();

    press("s", "n");

    await waitFor(() => expect(nameAt(1)).toBe("nates.txt"));
    const name = rows()[1]?.querySelector(".row__name");
    expect(name?.querySelector(".row__flash-query")?.textContent).toBe("n");
    expect(name?.querySelector(".row__flash-label")?.textContent).toBe("a");
  });

  it("dims the rows that do not match", async () => {
    await opened();

    press("s", "n");

    await waitFor(() => expect(flashStates()[0]).toBe("dim"));
    expect(rows()[0]?.className).toContain("row--flash-dim");
    expect(rows()[1]?.className).not.toContain("row--flash-dim");
  });
});

describe("jumping", () => {
  it("moves the cursor to the row whose label was pressed, and ends the session", async () => {
    await opened();
    expect(cursorIn("column-current")).toContain("projects");

    press("s", "n", "a");

    await waitFor(() => expect(cursorIn("column-current")).toContain("notes.txt"));
    expect(screen.queryByTestId("status-flash")).toBeNull();
    // The names are the names again.
    expect(nameAt(1)).toBe("notes.txt");
    expect(flashStates()).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("reaches a row further down on its own label", async () => {
    await opened();

    press("s", "n", "s");

    await waitFor(() => expect(cursorIn("column-current")).toContain("many"));
  });
});

describe("cancelling", () => {
  it("puts the cursor back where the session started and clears the drawing", async () => {
    await opened();
    // Move first, so "back where it started" is a claim about the session and
    // not about the top of the listing.
    press("j");
    await waitFor(() => expect(cursorIn("column-current")).toContain("notes.txt"));

    press("s", "n");
    await waitFor(() => expect(screen.getByTestId("status-flash")).toBeTruthy());
    press("Escape");

    await waitFor(() => expect(screen.queryByTestId("status-flash")).toBeNull());
    expect(cursorIn("column-current")).toContain("notes.txt");
    expect(nameAt(1)).toBe("notes.txt");
    expect(flashStates()[0]).toBeUndefined();
  });
});

describe("the session owns the keyboard", () => {
  it("takes j as a character to search for, not as a cursor move", async () => {
    await opened();
    expect(cursorRow()).toBe(0);

    press("s", "j");

    await waitFor(() => expect(screen.getByTestId("status-flash").textContent).toContain("j"));
    // By ROW and not by name: "projects" matches "j" at index 3, so while the
    // session runs its name is drawn overtyped as "projacts". Asserting on the
    // text would be asserting that the feature does not work.
    expect(cursorRow()).toBe(0);
  });
});

// ── Guards ─────────────────────────────────────────────────────────────────

describe("a listing that changes under a running session", () => {
  /**
   * Put a new entry at the TOP of the current directory and let it land.
   *
   * At the top on purpose: it shifts every index by one, which is what turns a
   * stale label into a jump to the wrong file rather than into a jump that
   * happens to still be right.
   *
   * The wait is two steps and both are needed, for the reason `search.test.tsx`
   * records at its own `refresh`: `waitFor` proves the listing reached the DOM,
   * and the empty `act` flushes the render the new listing schedules.
   */
  async function refresh(name: string): Promise<void> {
    const before = rows().length;
    log.addEntryFirst("/home/jc", name);
    for (const id of log.watched) log.emitChange(id);
    // Waited on the ROW COUNT, not on the name: a session overtypes every
    // matching name, so waiting for the plain text of an arrival that matches
    // is waiting for something the feature guarantees will not appear.
    await waitFor(() => expect(rows()).toHaveLength(before + 1));
    await act(async () => undefined);
  }

  it("relabels against the listing as it stands now", async () => {
    await opened();
    press("s", "n");
    await waitFor(() => expect(nameAt(1)).toBe("nates.txt"));

    await refresh("newcomer.txt");

    // Row 0 is the arrival, and it matches too — so the labels are a fresh
    // pass over seven rows, not the old pass over six with everything shifted.
    await waitFor(() => expect(flashStates()[0]).toBe("match"));
    const label = rows()[0]?.querySelector(".row__flash-label")?.textContent ?? "";
    expect(label).not.toBe("");
    // Whatever letter the pool handed out, it overtypes the `e` of "newcomer".
    expect(nameAt(0)).toBe(`n${label}wcomer.txt`);
  });

  it("jumps to the row the label is drawn on, not to the one it was drawn on", async () => {
    // ── The regression this block exists to prevent ────────────────────────
    // A label carries the index it was computed for. Before the fix, an entry
    // arriving at the top of the listing shifted every row by one while the
    // labels kept their old indices — so pressing a label moved the cursor to
    // the file ABOVE the one the user was looking at. Silently, and plausibly.
    await opened();
    press("s", "n");
    await waitFor(() => expect(nameAt(1)).toBe("nates.txt"));

    await refresh("newcomer.txt");
    await waitFor(() => expect(flashStates()[0]).toBe("match"));

    // Whatever label "notes.txt" carries NOW is the one that must reach it.
    const notesRow = rows().findIndex(
      (row) => row.dataset["flash"] === "match" && row.textContent?.includes("tes.txt"),
    );
    const label = rows()[notesRow]?.querySelector(".row__flash-label")?.textContent ?? "";
    expect(label).not.toBe("");

    press(label);

    await waitFor(() => expect(cursorIn("column-current")).toContain("notes.txt"));
  });

  it("puts the cursor back on the entry it started from, not on its old index", async () => {
    await opened();
    press("j");
    await waitFor(() => expect(cursorIn("column-current")).toContain("notes.txt"));

    press("s", "n");
    await waitFor(() => expect(screen.getByTestId("status-flash")).toBeTruthy());
    await refresh("newcomer.txt");
    press("Escape");

    // "notes.txt" is at index 2 now, not 1. Remembering the index alone would
    // have put the cursor back on "projects".
    await waitFor(() => expect(screen.queryByTestId("status-flash")).toBeNull());
    expect(cursorIn("column-current")).toContain("notes.txt");
  });
});

describe("what a session does not survive", () => {
  it("ends when the pane leaves the directory it was labelling", async () => {
    await opened();
    press("s", "n");
    await waitFor(() => expect(screen.getByTestId("status-flash")).toBeTruthy());

    // Moved from OUTSIDE, because no key can do it: the cascade hands every
    // key to the session, so `h` is a character to search for rather than the
    // go-up binding. Another program asking this window to show a path is the
    // one route a running session cannot swallow.
    act(() => log.emitOpenPath("/home/jc/projects"));

    await waitFor(() => expect(namesIn("column-current")).toContain("beta.md"));
    expect(screen.queryByTestId("status-flash")).toBeNull();
    expect(flashStates().every((state) => state === undefined)).toBe(true);
  });
});
