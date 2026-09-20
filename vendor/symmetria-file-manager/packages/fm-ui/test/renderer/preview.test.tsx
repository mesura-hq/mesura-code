/**
 * @vitest-environment happy-dom
 *
 * The preview pane, driven through the cursor.
 *
 * `route.test.ts` proves the decision tree. This proves the pane is wired to
 * it, that the debounce holds, and that a preview which cannot be built still
 * shows something truthful.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../src/App.tsx";
import { PreviewPane } from "../../src/components/preview/PreviewPane.tsx";
import { PREVIEW_DEBOUNCE_MS } from "../../src/usePreview.ts";
import { type BridgeLog, cursorIn, installBridge, namesIn } from "./support.ts";

let log: BridgeLog;

beforeEach(() => {
  log = installBridge();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function opened(): Promise<void> {
  render(<App startPath="/home/jc" />);
  await waitFor(() => expect(namesIn("column-current")).toContain("projects"));
}

describe("the preview column", () => {
  it("lists a directory's entries rather than trying to read it", async () => {
    // The cursor starts on `projects`, a directory.
    await opened();

    const shown = await screen.findByTestId("preview-directory");
    expect(
      within(shown)
        .getAllByTestId("preview-entry")
        .map((r) => r.textContent),
    ).toEqual(["alpha", "beta.md"]);
  });

  it("draws each listed entry with the icon its kind and name earn", async () => {
    // The same icon component the file rows use. A second mapping here would
    // drift, and a folder would eventually look like a folder in one column and
    // not in another.
    await opened();

    const shown = await screen.findByTestId("preview-directory");
    const rows = within(shown).getAllByTestId("preview-entry");

    expect(rows[0]?.querySelector(".file-icon")).not.toBeNull();
    expect(rows[0]?.dataset["kind"]).toBe("directory");
    expect(rows[1]?.dataset["kind"]).toBe("file");
  });

  it("says how many it is not showing when the listing is capped", async () => {
    // `many` is the last entry of the fixture home, so the bottom key reaches it
    // however many entries are added before it later.
    await opened();
    fireEvent.keyDown(window, { key: "G", shiftKey: true });
    await waitFor(() => expect(cursorIn("column-current")).toContain("many"));

    const shown = await screen.findByTestId("preview-directory");
    expect(within(shown).getAllByTestId("preview-entry")).toHaveLength(500);
    expect(shown.textContent).toContain("37 more");
  });

  it("says an empty directory is empty instead of showing nothing", async () => {
    await opened();
    fireEvent.keyDown(window, { key: "G", shiftKey: true });
    fireEvent.keyDown(window, { key: "k" });
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(cursorIn("column-current")).toContain("empty"));

    const shown = await screen.findByTestId("preview-directory");
    expect(within(shown).queryAllByTestId("preview-entry")).toHaveLength(0);
    expect(shown.textContent).toMatch(/empty/i);
  });

  it("shows the error and no rows for a directory it could not read", async () => {
    await opened();
    fireEvent.keyDown(window, { key: "G", shiftKey: true });
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(cursorIn("column-current")).toContain("locked"));

    await screen.findByTestId("preview-error");
    expect(screen.queryAllByTestId("preview-entry")).toHaveLength(0);
  });

  it("leaves the listed rows inert — they are a preview, not a third pane", async () => {
    // A click here would imply the column is navigable, and it is not: the
    // cursor lives in the middle column and entering is what moves it.
    await opened();
    const shown = await screen.findByTestId("preview-directory");
    const row = within(shown).getAllByTestId("preview-entry")[0];

    expect(row?.tagName).toBe("DIV");
    expect(row?.getAttribute("tabindex")).toBeNull();

    const before = [...log.listed];
    if (row !== undefined) fireEvent.click(row);
    expect(log.listed).toEqual(before);
  });

  it("renders a text file's contents", async () => {
    await opened();
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(cursorIn("column-current")).toContain("notes.txt"));

    const shown = await screen.findByTestId("preview-text");
    expect(shown.textContent).toContain("plain notes");
    expect(shown.textContent).toContain("second line");
  });

  it("renders a markdown file as a document rather than as its source", async () => {
    // AMENDED. This test used to assert `beta.md` reached the code branch with
    // `language: markdown`, which was the truth until rendering became the
    // default. It is kept pointed at the same file because it is the only
    // end-to-end proof that the wiring holds through the real application —
    // the router's answer, the describe reply's name and type, the pane's
    // choice — rather than through a component rendered on its own.
    await opened();
    fireEvent.keyDown(window, { key: "l" });
    await waitFor(() => expect(namesIn("column-current")).toContain("beta.md"));
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(cursorIn("column-current")).toContain("beta.md"));

    const shown = await screen.findByTestId("preview-markdown");
    // A heading element, not the two characters "# ".
    expect(within(shown).getByRole("heading", { name: "beta" })).toBeDefined();
    expect(shown.textContent).not.toContain("# beta");
  });

  it("routes a renderable HTML file to the framed page, not to its source", async () => {
    // The pane's own switch, driven directly. The three ways to show text —
    // rendered markdown, a framed page, highlighted source — are chosen in one
    // place, and this pins that an `html` answer reaches the frame.
    render(
      <PreviewPane
        route={{ kind: "code", language: "xml" }}
        path="/home/jc/page.html"
        size={0}
        renderAs="html"
      />,
    );

    expect(await screen.findByTestId("preview-html")).toBeDefined();
    expect(screen.queryByTestId("preview-code")).toBeNull();
  });

  it("still shows a file with no rendered form as highlighted source", async () => {
    // The other half of the amendment above. Driven through the pane rather
    // than through navigation, because adding a source file to the fixture
    // tree would shift every index the rest of the suite counts `j` presses
    // against.
    render(
      <PreviewPane
        route={{ kind: "code", language: "rust" }}
        path="/home/jc/notes.txt"
        size={0}
        renderAs={null}
      />,
    );

    const shown = await screen.findByTestId("preview-code");
    expect(shown.dataset["language"]).toBe("rust");
  });

  it("names the column by what the router chose", async () => {
    await opened();

    await waitFor(() =>
      expect(screen.getByTestId("column-preview").dataset["kind"]).toBe("directory"),
    );
  });
});

describe("the debounce", () => {
  it("does not describe every entry the cursor passes over", async () => {
    // Holding `j` through a directory would otherwise stat, resolve a MIME type
    // and read a head for every entry passed — work for a preview nobody sees.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<App startPath="/home/jc" />);
    await waitFor(() => expect(namesIn("column-current")).toContain("projects"));

    const before = log.described.length;
    for (let i = 0; i < 3; i++) {
      fireEvent.keyDown(window, { key: "j" });
      // Well inside the window, so each move cancels the previous one.
      await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS / 3);
    }
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS * 2);

    // One description for where the cursor came to rest, not one per step.
    // Three steps from `projects` lands on `empty` — the fixture home grew when
    // the directory listing arrived, and the count of steps is what this test
    // is about rather than which entry they end on.
    const asked = log.described.slice(before);
    expect(asked).toEqual(["/home/jc/empty"]);
  });

  it("describes the entry the cursor settles on", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<App startPath="/home/jc" />);
    await waitFor(() => expect(namesIn("column-current")).toContain("projects"));

    fireEvent.keyDown(window, { key: "j" });
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS * 2);

    expect(log.described).toContain("/home/jc/notes.txt");
  });
});

describe("a preview that cannot be built", () => {
  it("says why, instead of showing an empty column", async () => {
    // A file the process cannot stat — no permission, or gone between the
    // cursor landing and the read — used to produce an empty column
    // indistinguishable from an empty file.
    render(<App startPath="/home/jc/projects" />);
    await waitFor(() => expect(namesIn("column-current")).toContain("beta.md"));

    // `alpha` is a directory the fixture does not describe.
    const shown = await screen.findByTestId("preview-error");
    expect(shown.textContent).toContain("alpha");
  });
});
