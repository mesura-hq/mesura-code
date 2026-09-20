/**
 * @vitest-environment happy-dom
 *
 * Flash across all three Miller columns.
 *
 * ── The fixture's labels, derived once ──────────────────────────────────────
 * Home is /home/jc holding projects · notes.txt · todo.txt · empty · locked ·
 * many, with the cursor on `projects`. Its parent /home holds jc · other. The
 * previewed directory, while the cursor sits on `projects`, is
 * /home/jc/projects holding alpha · beta.md.
 *
 * A query of "o" reaches four rows of the current column (projects, notes.txt,
 * todo.txt, locked), nothing in the preview, and `other` in the parent. The
 * characters following those `o`s are j · t · d · . · c, so the pool loses
 * those and `o` itself, and hands out a · s · f · g to the current column in
 * cursor order and then h to `other`.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../../src/App.tsx";
import { cursorIn, installBridge, namesIn } from "./support.ts";

beforeEach(installBridge);
afterEach(cleanup);

async function opened(): Promise<void> {
  render(<App startPath="/home/jc" />);
  await waitFor(() => expect(namesIn("column-current")).toContain("projects"));
}

/** Wait for the previewed directory to arrive — it is debounced by 150 ms. */
async function previewListed(): Promise<HTMLElement> {
  return await screen.findByTestId("preview-directory");
}

/** The rows of a column that a running session has labelled. */
function matchedRows(testId: string, rowTestId = "row"): HTMLElement[] {
  return within(screen.getByTestId(testId))
    .getAllByTestId(rowTestId)
    .filter((row) => row.dataset["flash"] === "match");
}

function press(...keys: readonly string[]): void {
  for (const key of keys) fireEvent.keyDown(window, { key });
}

/**
 * The label drawn on the row at `index` of a column.
 *
 * By POSITION and not by name: a labelled row's name is overtyped, so
 * `projects` is drawn `projeats` and no name-based lookup can find it. The
 * position is the row's index in the listing, which is what a label addresses
 * anyway.
 */
function labelAt(testId: string, rowTestId: string, index: number): string {
  const row = within(screen.getByTestId(testId)).getAllByTestId(rowTestId)[index];
  return row?.querySelector(".row__flash-label")?.textContent ?? "";
}

describe("the parent column", () => {
  it("labels its rows too", async () => {
    await opened();

    press("s", "o");

    await waitFor(() => expect(labelAt("column-parent", "row", 1)).not.toBe(""));
    // Last of the six, because the parent column sorts after both the others.
    expect(labelAt("column-parent", "row", 1)).toBe("h");
  });

  it("leaves the directory and lands the cursor on the labelled entry", async () => {
    await opened();

    press("s", "o", "h");

    await waitFor(() => expect(namesIn("column-current")).toContain("other"));
    expect(cursorIn("column-current")).toContain("other");
  });
});

describe("the previewed directory", () => {
  it("labels its rows with the same drawing as the navigable columns", async () => {
    await opened();
    const preview = await previewListed();
    expect(within(preview).getAllByTestId("preview-entry").length).toBeGreaterThan(0);

    press("s", "a");

    // "alpha" and "beta.md" both hold an `a`; so does `many` in the current
    // column, which sorts first and takes `s`.
    await waitFor(() => expect(labelAt("preview-directory", "preview-entry", 0)).toBe("d"));
    expect(labelAt("preview-directory", "preview-entry", 1)).toBe("f");
    const row = within(screen.getByTestId("preview-directory")).getAllByTestId("preview-entry")[0];
    expect(row?.querySelector(".row__flash-query")?.textContent).toBe("a");
  });

  it("enters the directory and lands the cursor on the labelled entry", async () => {
    await opened();
    await previewListed();

    press("s", "a", "d");

    await waitFor(() => expect(namesIn("column-current")).toContain("alpha"));
    expect(cursorIn("column-current")).toContain("alpha");
  });

  it("offers nothing while the cursor is on a file", async () => {
    await opened();
    await previewListed();
    // `notes.txt` has no previewed directory behind it.
    press("j");
    await waitFor(() => expect(screen.queryByTestId("preview-directory")).toBeNull());

    press("s", "a");

    // Only `many` matches now, and it is in the current column.
    await waitFor(() => expect(screen.getByTestId("status-flash")).toBeTruthy());
    expect(screen.queryByTestId("preview-directory")).toBeNull();
    expect(matchedRows("column-current")).toHaveLength(1);

    // The same query with the cursor back on a DIRECTORY reaches three rows,
    // so the difference is a property of what the cursor is on rather than of
    // the query.
    press("Escape");
    press("k");
    await previewListed();
    press("s", "a");
    await waitFor(() => expect(labelAt("preview-directory", "preview-entry", 0)).not.toBe(""));
    expect(matchedRows("column-current")).toHaveLength(1);
    expect(matchedRows("preview-directory", "preview-entry")).toHaveLength(2);
  });
});

describe("priority across the three columns", () => {
  it("labels the current column first, then the preview, then the parent", async () => {
    await opened();
    await previewListed();

    // "e" reaches four rows of the current column, `beta.md` in the preview and
    // `other` in the parent. The characters after those `e`s are c · s · m · d
    // · t · r, so the pool hands out a · f · g · h, then j, then k.
    press("s", "e");

    await waitFor(() => expect(labelAt("column-current", "row", 0)).toBe("a"));
    expect(labelAt("preview-directory", "preview-entry", 1)).toBe("j");
    expect(labelAt("column-parent", "row", 1)).toBe("k");
  });
});

// ── Guards ─────────────────────────────────────────────────────────────────

describe("a column that arrives after the session started", () => {
  it("does not join it, and the labels already drawn do not move", async () => {
    // ── The regression this guard exists to prevent ────────────────────────
    // The previewed directory arrives 150 ms after the cursor lands on one. A
    // session started inside that window used to gain a whole third column
    // part-way through, and every label moved with it — verification watched
    // the parent column's `g` and `h` become `k` and `l` while it ran. A label
    // the user has already read must not change what it means.
    await opened();
    expect(screen.queryByTestId("preview-directory")).toBeNull();

    press("s", "e");
    await waitFor(() => expect(labelAt("column-current", "row", 0)).not.toBe(""));
    const parentLabel = labelAt("column-parent", "row", 1);
    expect(parentLabel).not.toBe("");

    // Now let it arrive.
    await previewListed();

    expect(labelAt("preview-directory", "preview-entry", 1)).toBe("");
    expect(labelAt("column-parent", "row", 1)).toBe(parentLabel);
  });

  it("joins the NEXT session, which starts from what is there now", async () => {
    await opened();
    press("s", "e");
    await waitFor(() => expect(labelAt("column-current", "row", 0)).not.toBe(""));
    await previewListed();

    press("Escape");
    await waitFor(() => expect(screen.queryByTestId("status-flash")).toBeNull());
    press("s", "e");

    // `beta.md` holds an `e`, and this session can see it.
    await waitFor(() => expect(labelAt("preview-directory", "preview-entry", 1)).not.toBe(""));
  });
});
