/**
 * @vitest-environment happy-dom
 *
 * The pointer.
 *
 * Until this phase the whole application was keyboard-only: not one component
 * carried an `onClick`, so clicking a folder did nothing at all. These pin what
 * a click means in each of the three columns, and — the part a component test
 * is uniquely bad at and this file is careful about — that a click does not
 * take the keyboard with it.
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

/** One row of a column, by the name it shows. */
function rowNamed(testId: string, name: string): HTMLElement {
  const found = within(screen.getByTestId(testId))
    .getAllByTestId("row")
    .find((row) => row.textContent?.includes(name));
  if (found === undefined) throw new Error(`no row named ${name} in ${testId}`);
  return found;
}

describe("clicking in the current column", () => {
  it("moves the cursor to the clicked row", async () => {
    await opened();
    expect(cursorIn("column-current")).toContain("projects");

    fireEvent.click(rowNamed("column-current", "notes.txt"));

    await waitFor(() => expect(cursorIn("column-current")).toContain("notes.txt"));
  });

  it("does not enter a directory on a single click", async () => {
    // One click selects, two enter — the same split every file manager uses,
    // and the reason a single click can be used to look at a preview.
    await opened();
    const before = [...log.listed];

    fireEvent.click(rowNamed("column-current", "projects"));

    await waitFor(() => expect(cursorIn("column-current")).toContain("projects"));
    expect(log.listed).toEqual(before);
  });

  it("enters a directory on a double click", async () => {
    await opened();

    fireEvent.doubleClick(rowNamed("column-current", "projects"));

    await waitFor(() => expect(namesIn("column-current")).toContain("beta.md"));
  });

  it("hands a file to the desktop on a double click", async () => {
    await opened();

    fireEvent.doubleClick(rowNamed("column-current", "notes.txt"));

    await waitFor(() => expect(log.ops).toContain("open /home/jc/notes.txt"));
  });

  it("targets what was clicked, not where the cursor was", async () => {
    // The order matters: move the cursor first, then act. Acting first would
    // open whatever the cursor happened to be sitting on.
    await opened();
    expect(cursorIn("column-current")).toContain("projects");

    fireEvent.doubleClick(rowNamed("column-current", "notes.txt"));

    await waitFor(() => expect(log.ops).toContain("open /home/jc/notes.txt"));
    expect(log.ops.some((op) => op.includes("projects"))).toBe(false);
  });
});

describe("clicking in the parent column", () => {
  it("enters a sibling directory on a single click", async () => {
    // The parent column is not where the cursor lives, so there is no selecting
    // to do there — one click is the whole gesture.
    render(<App startPath="/home/jc/projects" />);
    await waitFor(() => expect(namesIn("column-current")).toContain("beta.md"));

    // `empty` is a sibling of `projects` under the fixture home.
    fireEvent.click(rowNamed("column-parent", "empty"));

    await waitFor(() => expect(screen.getByTestId("crumb-current").textContent).toBe("empty"));
  });

  it("keeps the listing when the click lands on the directory we are already in", async () => {
    // The parent column always shows the current directory among the siblings,
    // and highlights it — so it is the most obvious row in that column to click
    // and the one most likely to be clicked by accident. It is a jump to where
    // we already are, and a jump like that used to empty the column for good.
    render(<App startPath="/home/jc/projects" />);
    await waitFor(() => expect(namesIn("column-current")).toContain("beta.md"));
    const before = [...log.listed];

    fireEvent.click(rowNamed("column-parent", "projects"));

    await act(async () => undefined);
    expect(namesIn("column-current")).toContain("beta.md");
    expect(screen.getByTestId("crumb-current").textContent).toBe("projects");
    expect(log.listed).toEqual(before);
  });

  it("leaves a file in that column inert, because it is not a destination", async () => {
    // Entering a file is impossible, and opening one on a SINGLE click — in a
    // column the pointer only passes through on its way somewhere else — would
    // hand it to a desktop application by accident.
    render(<App startPath="/home/jc/projects" />);
    await waitFor(() => expect(namesIn("column-current")).toContain("beta.md"));

    const file = rowNamed("column-parent", "notes.txt");
    expect(file.className).not.toContain("row--clickable");

    const before = [...log.listed];
    fireEvent.click(file);
    expect(log.listed).toEqual(before);
    expect(log.ops).toEqual([]);
  });
});

describe("clicking a breadcrumb", () => {
  it("navigates to that segment", async () => {
    render(<App startPath="/home/jc/projects" />);
    await waitFor(() => expect(namesIn("column-current")).toContain("beta.md"));

    fireEvent.click(within(screen.getByTestId("path-bar")).getByText("jc"));

    await waitFor(() => expect(namesIn("column-current")).toContain("notes.txt"));
  });

  it("leaves the last segment inert — it is where we already are", async () => {
    await opened();
    const before = [...log.listed];

    fireEvent.click(screen.getByTestId("crumb-current"));

    expect(log.listed).toEqual(before);
  });
});

describe("the keyboard survives a click", () => {
  it("dispatches the next key press normally", async () => {
    // The failure this pins: a row that takes focus swallows the keys that
    // follow, so the pointer works once and then the application appears dead.
    // The document-level handler only sees a key if nothing else claimed it.
    await opened();

    fireEvent.click(rowNamed("column-current", "notes.txt"));
    await waitFor(() => expect(cursorIn("column-current")).toContain("notes.txt"));

    fireEvent.keyDown(window, { key: "j" });

    await waitFor(() => expect(cursorIn("column-current")).toContain("todo.txt"));
  });

  it("leaves focus on the body rather than on the clicked row", async () => {
    await opened();
    const row = rowNamed("column-current", "notes.txt");

    fireEvent.mouseDown(row);
    fireEvent.click(row);

    expect(document.activeElement).not.toBe(row);
  });
});

describe("what a click cannot reach", () => {
  it("leaves the preview column inert", async () => {
    await opened();
    const shown = await screen.findByTestId("preview-directory");
    const before = [...log.listed];

    // `getAllBy*` throws when it finds nothing, so this is a real element and
    // not an assertion that it is one.
    const [first] = within(shown).getAllByTestId("preview-entry");
    if (first !== undefined) fireEvent.click(first);

    expect(log.listed).toEqual(before);
  });

  it("offers a pointer cursor only where a click does something", async () => {
    await opened();

    expect(rowNamed("column-current", "notes.txt").className).toContain("row--clickable");
    expect(rowNamed("column-parent", "jc").className).toContain("row--clickable");
    expect(rowNamed("column-parent", "other").className).toContain("row--clickable");

    const shown = await screen.findByTestId("preview-directory");
    const preview = within(shown).getAllByTestId("preview-entry")[0];
    expect(preview?.className).not.toContain("row--clickable");
  });
});
