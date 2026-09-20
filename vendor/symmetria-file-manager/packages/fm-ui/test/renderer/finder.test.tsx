/**
 * @vitest-environment happy-dom
 *
 * Finding a file by typing part of its name.
 *
 * `f` opens the overlay, typing narrows a ranked list, Enter takes you to the
 * result. What is proved here is the surface and the rules around it: the query
 * is debounced, the matched characters are marked, the confirm key is blocked
 * while the visible rows answer an older query, and a directory is entered
 * where a file is revealed.
 *
 * The engine is a fixture. Ranking, the trailing-separator rule and the
 * recomputed match positions are proved in `packages/fm-search` against the
 * real one; repeating that here would test the fixture.
 */
import type { SearchReplyRow } from "@symmetria/fm-core/contract";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../src/App.tsx";
import { type BridgeLog, cursorIn, installBridge, namesIn } from "./support.ts";

/** How long the finder's query debounce is. Kept in step with `SEARCH_DEBOUNCE_MS`. */
const DEBOUNCE_MS = 100;

function row(
  relativePath: string,
  name: string,
  over: Partial<SearchReplyRow> = {},
): SearchReplyRow {
  return {
    relativePath,
    name,
    fullPath: `/home/jc/${relativePath}`,
    isDir: relativePath.endsWith("/"),
    score: 100,
    size: 10,
    modifiedMs: 0,
    gitStatus: "clean",
    matchIndices: [],
    ...over,
  };
}

let log: BridgeLog;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

async function opened(options: Parameters<typeof installBridge>[0] = {}): Promise<void> {
  log = installBridge(options);
  render(<App startPath="/home/jc" homePath="/home/jc" />);
  await waitFor(() => expect(namesIn("column-current").length).toBeGreaterThan(0));
  await act(async () => undefined);
  fireEvent.keyDown(window, { key: "f" });
  await screen.findByTestId("finder");
}

/** Type into the overlay's field and let its debounce elapse. */
async function type(text: string): Promise<void> {
  fireEvent.change(screen.getByTestId("finder-query"), { target: { value: text } });
  await act(async () => {
    vi.advanceTimersByTime(DEBOUNCE_MS);
  });
}

function pressInFinder(key: string, init: Partial<KeyboardEventInit> = {}): void {
  fireEvent.keyDown(screen.getByTestId("finder-query"), { key, ...init });
}

/** The rows the overlay is showing, in order. */
function rows(): string[] {
  return within(screen.getByTestId("finder"))
    .queryAllByTestId("finder-row")
    .map((element) => element.textContent ?? "");
}

describe("opening the finder", () => {
  it("opens on the finder key instead of reporting the feature as unbuilt", async () => {
    await opened();
    expect(screen.getByTestId("finder")).toBeTruthy();
    // The stub it replaced put this sentence in the status bar.
    expect(screen.queryByText(/is not built yet/)).toBeNull();
  });

  it("opens an index over the directory the pane is showing", async () => {
    await opened();
    expect(log.searchStarts).toEqual(["/home/jc"]);
  });

  it("says so while the first scan is running", async () => {
    // A slow scan and an empty tree look identical otherwise, and only one of
    // them is worth waiting through. The fixture holds the open so the state
    // can be observed at all.
    await opened({ searchStartHeld: true });
    expect(screen.getByTestId("finder-status").textContent).toBe("Indexing\u2026");

    // Paired with the release, so an overlay stuck on "Indexing…" forever
    // could not pass this test.
    await act(async () => {
      log.releaseSearchStart();
    });
    await waitFor(() =>
      expect(screen.getByTestId("finder-status").textContent).toBe("No files in this scope"),
    );
  });

  it("reports an index that could not be opened", async () => {
    await opened({ searchStartFails: "Permission denied", search: () => [row("a.ts", "a.ts")] });
    await waitFor(() =>
      expect(screen.getByTestId("finder-status").textContent).toBe("Permission denied"),
    );
    await type("a");
    expect(log.searchQueries).toEqual([]);
    expect(screen.getByTestId("finder-status").textContent).toBe("Permission denied");
  });
});

describe("typing a query", () => {
  it("narrows the list to what the engine answered", async () => {
    await opened({
      search: (query) => (query === "fmt" ? [row("src/format.ts", "format.ts")] : []),
    });
    await type("fmt");
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toContain("format.ts");
  });

  it("waits for typing to settle before searching at all", async () => {
    // One search for a word typed in four keystrokes, not four. Without the
    // debounce every character costs a round trip to a native engine.
    await opened({ search: () => [] });
    const field = screen.getByTestId("finder-query");
    for (const text of ["f", "fo", "for", "form"]) {
      fireEvent.change(field, { target: { value: text } });
      await act(async () => {
        vi.advanceTimersByTime(DEBOUNCE_MS / 4);
      });
    }
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    expect(log.searchQueries).toEqual(["form"]);
  });

  it("shows suggestions on open and restores them when the query is cleared", async () => {
    await opened({
      search: (query) => (query === "" ? [row("README.md", "README.md")] : [row("a.ts", "a.ts")]),
    });
    await waitFor(() => expect(rows()).toEqual([expect.stringContaining("README.md")]));
    expect(screen.getByTestId("finder-status").textContent).toBe("Suggested files");
    await type("a");
    await waitFor(() => expect(rows()).toEqual([expect.stringContaining("a.ts")]));
    await type("");
    await waitFor(() => expect(rows()).toEqual([expect.stringContaining("README.md")]));
    expect(log.searchQueries).toEqual(["", "a", ""]);
  });

  it("does not choose an old search result while suggestions are pending", async () => {
    await opened({ search: () => [row("a.ts", "a.ts")] });
    await type("a");
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.change(screen.getByTestId("finder-query"), { target: { value: "" } });
    pressInFinder("Enter");
    expect(screen.getByTestId("finder")).toBeTruthy();
    expect(log.searchRecords).toEqual([]);
  });

  it("marks the matched characters apart from the rest of the name", async () => {
    await opened({
      search: () => [row("src/format.ts", "format.ts", { matchIndices: [4, 7, 9] })],
    });
    await type("fmt");
    await waitFor(() => expect(rows()).toHaveLength(1));
    // Positions 4, 7 and 9 of "src/format.ts" are `f`, `m` and `t` — the name
    // starts at 4, so all three land inside it.
    const marks = within(screen.getByTestId("finder-row")).getAllByText(
      (_, element) => element?.tagName === "MARK",
    );
    expect(marks.map((mark) => mark.textContent)).toEqual(["f", "m", "t"]);
  });

  it("marks a match that fell in the directory rather than the name", async () => {
    // Positions 0, 1 and 2 are `s`, `r`, `c` — inside the directory part. A
    // renderer that only marked the name would show this row with no marks at
    // all, which reads as a result that should not be there.
    await opened({
      search: () => [row("src/format.ts", "format.ts", { matchIndices: [0, 1, 2] })],
    });
    await type("src");
    await waitFor(() => expect(rows()).toHaveLength(1));
    const directory = screen.getByTestId("finder-row-directory");
    expect(within(directory).getByText("src").tagName).toBe("MARK");
  });

  it("shows the file name and the directory it sits in", async () => {
    await opened({ search: () => [row("src/deep/format.ts", "format.ts")] });
    await type("fmt");
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.getByTestId("finder-row-name").textContent).toBe("format.ts");
    expect(screen.getByTestId("finder-row-directory").textContent).toBe("src/deep/");
  });

  it("counts the results, and says when the list was cut short", async () => {
    await opened({
      search: (query) =>
        query === "many"
          ? Array.from({ length: 200 }, (_, at) => row(`f${at}.ts`, `f${at}.ts`))
          : [row("a.ts", "a.ts"), row("b.ts", "b.ts")],
    });
    await type("ab");
    await waitFor(() => expect(screen.getByTestId("finder-status").textContent).toBe("2 results"));
    await type("many");
    await waitFor(() =>
      expect(screen.getByTestId("finder-status").textContent).toBe("First 200 of more"),
    );
  });
});

describe("moving through the results", () => {
  const three = () => [row("a.ts", "a.ts"), row("b.ts", "b.ts"), row("c.ts", "c.ts")];

  async function threeShown(): Promise<void> {
    await opened({ search: three });
    await type("x");
    await waitFor(() => expect(rows()).toHaveLength(3));
  }

  function activeRow(): string {
    const active = within(screen.getByTestId("finder")).getAllByTestId("finder-row");
    return active.find((element) => element.dataset.active === "true")?.textContent ?? "";
  }

  it("starts on the first result", async () => {
    await threeShown();
    expect(activeRow()).toContain("a.ts");
  });

  it("moves down and up with the arrows", async () => {
    await threeShown();
    pressInFinder("ArrowDown");
    expect(activeRow()).toContain("b.ts");
    pressInFinder("ArrowUp");
    expect(activeRow()).toContain("a.ts");
  });

  it("moves with the control pair as well", async () => {
    // Ctrl+J and Ctrl+K, which is what the Qt finder binds.
    await threeShown();
    pressInFinder("j", { ctrlKey: true });
    expect(activeRow()).toContain("b.ts");
    pressInFinder("k", { ctrlKey: true });
    expect(activeRow()).toContain("a.ts");
  });

  it("stops at the ends rather than wrapping", async () => {
    await threeShown();
    pressInFinder("ArrowUp");
    expect(activeRow()).toContain("a.ts");
    for (let at = 0; at < 5; at += 1) pressInFinder("ArrowDown");
    expect(activeRow()).toContain("c.ts");
  });
});

describe("choosing a result", () => {
  it("closes the overlay and puts the cursor on the chosen file", async () => {
    await opened({
      search: () => [row("notes/todo.md", "todo.md", { fullPath: "/home/jc/notes/todo.md" })],
    });
    await type("todo");
    await waitFor(() => expect(rows()).toHaveLength(1));
    pressInFinder("Enter");

    await waitFor(() => expect(screen.queryByTestId("finder")).toBeNull());
    await waitFor(() => expect(log.listed).toContain("/home/jc/notes"));
  });

  it("navigates INTO a directory rather than revealing it", async () => {
    await opened({
      search: () => [row("notes/", "notes", { fullPath: "/home/jc/notes/", isDir: true })],
    });
    await type("notes");
    await waitFor(() => expect(rows()).toHaveLength(1));
    pressInFinder("Enter");
    await waitFor(() => expect(screen.queryByTestId("finder")).toBeNull());
    // The directory itself is listed, not its parent — which is what a reveal
    // would have asked for.
    await waitFor(() => expect(log.listed).toContain("/home/jc/notes"));
  });

  it("strips the engine's trailing separator from the path it hands back", async () => {
    // The engine gives a directory a trailing separator on both path forms and
    // keys its own store on that. Nothing else in the application spells a path
    // that way, so `/home/jc/notes/` reaching the pane would make every later
    // `join(path, name)` build `/home/jc/notes//file` — which works on Linux
    // and silently stops matching the same directory written the normal way.
    await opened({
      search: () => [row("notes/", "notes", { fullPath: "/home/jc/notes/", isDir: true })],
    });
    await type("notes");
    await waitFor(() => expect(rows()).toHaveLength(1));
    pressInFinder("Enter");

    await waitFor(() => expect(log.listed).toContain("/home/jc/notes"));
    expect(log.listed.filter((path) => path.includes("//"))).toEqual([]);
    // The tracker write keeps the ENGINE's spelling, because the engine's store
    // is keyed on it. The two are deliberately different, and that is the point
    // of asserting both in one test.
    expect(log.searchRecords).toEqual([{ query: "notes", chosenPath: "/home/jc/notes/" }]);
  });

  it("attributes the chosen file to the query that found it", async () => {
    await opened({
      search: () => [row("src/format.ts", "format.ts", { fullPath: "/home/jc/src/format.ts" })],
    });
    await type("fmt");
    await waitFor(() => expect(rows()).toHaveLength(1));
    pressInFinder("Enter");
    expect(log.searchRecords).toEqual([{ query: "fmt", chosenPath: "/home/jc/src/format.ts" }]);
  });

  it("refuses to act while the rows answer an older query", async () => {
    // The correction this exists for: pressing Enter as results update opens
    // whichever file the OLDER list had under the highlight.
    await opened({ search: () => [row("a.ts", "a.ts", { fullPath: "/home/jc/a.ts" })] });
    await type("a");
    await waitFor(() => expect(rows()).toHaveLength(1));

    // Typed, but the debounce has NOT elapsed: the visible row still answers
    // "a" while the field reads "ab".
    fireEvent.change(screen.getByTestId("finder-query"), { target: { value: "ab" } });
    pressInFinder("Enter");
    expect(screen.queryByTestId("finder")).not.toBeNull();
    expect(log.searchRecords).toEqual([]);

    // Paired: once the newer answer arrives, the same key works. Without this
    // a finder whose Enter never worked at all would pass the assertions above.
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    await waitFor(() => expect(rows()).toHaveLength(1));
    pressInFinder("Enter");
    await waitFor(() => expect(screen.queryByTestId("finder")).toBeNull());
  });

  it("does nothing on an empty list", async () => {
    await opened({ search: () => [] });
    await type("nothing");
    expect(() => pressInFinder("Enter")).not.toThrow();
    expect(screen.queryByTestId("finder")).not.toBeNull();
  });
});

describe("leaving the finder", () => {
  it("closes on Escape and leaves the cursor where it was", async () => {
    await opened({ search: () => [row("a.ts", "a.ts")] });
    const before = [...log.listed];
    await type("a");
    await waitFor(() => expect(rows()).toHaveLength(1));
    pressInFinder("Escape");
    await waitFor(() => expect(screen.queryByTestId("finder")).toBeNull());
    expect(log.listed).toEqual(before);
  });

  it("closes on Escape even when focus has left the field", async () => {
    // The regression the zoxide popup had: Tab moved focus off the field and
    // the dialog became unclosable by keyboard, because the cascade's modal
    // step only calls `preventDefault`.
    await opened();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("finder")).toBeNull());
  });

  it("keeps Tab inside the overlay", async () => {
    await opened();
    pressInFinder("Tab");
    expect(screen.queryByTestId("finder")).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("finder-query"));
  });
});

describe("the icon on each row", () => {
  /** The `data-icon` each row's icon reports, in order. */
  function icons(): string[] {
    return within(screen.getByTestId("finder"))
      .queryAllByTestId("finder-row")
      .map((element) => element.querySelector("[data-icon]")?.getAttribute("data-icon") ?? "");
  }

  it("draws one, so a row is not four words of undifferentiated text", async () => {
    await opened({ search: () => [row("src/format.ts", "format.ts")] });
    await type("fmt");
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(icons()).toEqual(["typescript"]);
  });

  it("draws a different symbol per kind, from the shared resolver", async () => {
    // `@symmetria/fm-core/icons/resolve` is the single place that decides
    // this, and the pane's rows and the directory preview read the same table.
    // Change an icon there and it changes in all three.
    await opened({
      search: () => [
        row("a.ts", "a.ts"),
        row("b.md", "b.md"),
        row("c.png", "c.png"),
        row("d.rs", "d.rs"),
      ],
    });
    await type("x");
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(icons()).toEqual(["typescript", "markdown", "image", "rust"]);
  });

  it("draws a folder for a directory", async () => {
    // `isDir` is NOT overridden: `row()` derives it from the trailing
    // separator, and restating it here would hide a regression in that
    // derivation behind a value the test supplied itself.
    await opened({ search: () => [row("notes/", "notes")] });
    await type("notes");
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(icons()).toEqual(["folder"]);
  });

  it("draws video, audio and document symbols a search row has no MIME type for", async () => {
    // The gap this closed. A search index carries no type at all, so these
    // three resolved to the blank `default` symbol until the shared resolver
    // learnt to answer from a name as well.
    await opened({
      search: () => [row("a.mp4", "a.mp4"), row("b.flac", "b.flac"), row("c.pdf", "c.pdf")],
    });
    await type("x");
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(icons()).toEqual(["video", "audio", "document"]);
  });

  it("puts the icon sprite in the document exactly once, however many rows draw", async () => {
    // The sprite is 37 kilobytes of `<symbol>` definitions that every `<use>`
    // reference needs present somewhere in the document. It is injected from a
    // hook that runs once per ICON — every pane row, every archive entry, every
    // result — so "exactly once" is the whole contract, and nothing tested it.
    await opened({
      search: () => Array.from({ length: 6 }, (_, at) => row(`f${at}.ts`, `f${at}.ts`)),
    });
    await type("f");
    await waitFor(() => expect(rows()).toHaveLength(6));

    const hosts = document.querySelectorAll("#symmetria-fm-icon-sprite");
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.innerHTML ?? "").not.toBe("");
  });

  it("falls back rather than drawing nothing for an unknown extension", async () => {
    // A file manager that showed no icon for an unrecognised file would show
    // none for much of a real tree.
    await opened({ search: () => [row("a.zzzz", "a.zzzz")] });
    await type("x");
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(icons()).toEqual(["default"]);
  });
});

it("reveals a finder result in the current directory", async () => {
  await opened({ search: () => [row("notes.txt", "notes.txt")] });
  await type("notes");
  await waitFor(() => expect(rows()).toHaveLength(1));
  pressInFinder("Enter");
  await waitFor(() => expect(screen.queryByTestId("finder")).toBeNull());
  await waitFor(() => expect(cursorIn("column-current")).toBe("notes.txt"));
  expect(log.ops).toEqual([]);
});
