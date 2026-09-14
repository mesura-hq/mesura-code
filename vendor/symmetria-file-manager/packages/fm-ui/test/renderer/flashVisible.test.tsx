/**
 * @vitest-environment happy-dom
 *
 * Only what can be seen gets a label.
 *
 * The one place this port deliberately departs from the Qt build, and the
 * operator chose it: Qt labels every match in the listing, including rows
 * scrolled far out of view — so labels exist that nobody can read, and they
 * have spent characters from a pool of twenty-six.
 *
 * ── The trap this suite exists to hold ──────────────────────────────────────
 * `FileList` force-mounts the cursor row even when it is scrolled away, so the
 * rows in the document are NOT the rows on screen. Measured here: with the
 * listing scrolled to 2400 pixels, the document holds index 0 — the cursor —
 * together with indices 100 to 141. Reading the mounted set would hand the
 * engine a row the user cannot see.
 */
import type { FsEntry } from "@symmetria/fm-core/entry";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../src/App.tsx";
import { FileList, NO_SELECTION } from "../../src/components/FileList.tsx";
import { installBridge, namesIn } from "./support.ts";

beforeEach(installBridge);
afterEach(cleanup);

/** A listing long enough that most of it is off screen. */
function longListing(count: number): FsEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `f${String(index).padStart(4, "0")}.txt`,
    kind: "file" as const,
    size: 3,
    modifiedMs: 0,
    isSymlink: false,
    isHidden: false,
  }));
}

/** Open the fixture's long directory and wait for it to list. */
async function openedLong(): Promise<HTMLElement> {
  render(<App startPath="/home/jc/many" />);
  await waitFor(() => expect(namesIn("column-current").length).toBeGreaterThan(10));
  return screen.getByTestId("column-current");
}

/** Scroll a column and let the virtualiser observe it. */
async function scrollTo(column: HTMLElement, offset: number): Promise<void> {
  column.scrollTop = offset;
  column.dispatchEvent(new Event("scroll"));
  await waitFor(() => expect(namesIn("column-current")).not.toContain("f0001.txt"));
}

/** The rows of the current column that carry a label, by drawn name. */
function labelled(): string[] {
  return within(screen.getByTestId("column-current"))
    .getAllByTestId("row")
    .filter((row) => row.dataset["flash"] === "match")
    .map((row) => row.querySelector(".row__name")?.textContent ?? "");
}

function press(...keys: readonly string[]): void {
  for (const key of keys) fireEvent.keyDown(window, { key });
}

describe("the list reports what it has rendered", () => {
  it("reports a range on mount and again whenever it changes", async () => {
    const onVisibleRange = vi.fn();
    render(
      <FileList
        entries={longListing(500)}
        cursorIndex={0}
        testId="column-current"
        selection={NO_SELECTION}
        onVisibleRange={onVisibleRange}
      />,
    );

    await waitFor(() => expect(onVisibleRange).toHaveBeenCalled());
    const first = onVisibleRange.mock.calls.at(-1)?.[0];
    expect(first.start).toBe(0);
    expect(first.end).toBeGreaterThan(10);

    const column = screen.getByTestId("column-current");
    column.scrollTop = 2400;
    column.dispatchEvent(new Event("scroll"));

    await waitFor(() => {
      const latest = onVisibleRange.mock.calls.at(-1)?.[0];
      expect(latest.start).toBeGreaterThan(50);
    });
  });

  it("reports the whole listing when it is shorter than the viewport", async () => {
    const onVisibleRange = vi.fn();
    render(
      <FileList
        entries={longListing(6)}
        cursorIndex={0}
        testId="column-current"
        selection={NO_SELECTION}
        onVisibleRange={onVisibleRange}
      />,
    );

    await waitFor(() => expect(onVisibleRange).toHaveBeenCalled());
    expect(onVisibleRange.mock.calls.at(-1)?.[0]).toEqual({ start: 0, end: 5 });
  });

  it("leaves out the cursor row it mounts anyway when that row is off screen", async () => {
    const onVisibleRange = vi.fn();
    render(
      <FileList
        entries={longListing(500)}
        cursorIndex={0}
        testId="column-current"
        selection={NO_SELECTION}
        onVisibleRange={onVisibleRange}
      />,
    );
    await waitFor(() => expect(onVisibleRange).toHaveBeenCalled());

    const column = screen.getByTestId("column-current");
    column.scrollTop = 2400;
    column.dispatchEvent(new Event("scroll"));

    await waitFor(() => expect(onVisibleRange.mock.calls.at(-1)?.[0].start).toBeGreaterThan(50));
    // The cursor row is index 0 and IS in the document — the list mounts it on
    // purpose so the highlight survives a disagreement about the offset. It is
    // not on screen, so it is not in the range.
    expect(
      within(column)
        .getAllByTestId("row")
        .some((row) => row.textContent?.includes("f0000")),
    ).toBe(true);
    expect(onVisibleRange.mock.calls.at(-1)?.[0].start).toBeGreaterThan(0);
  });
});

describe("a session over a scrolled column", () => {
  /**
   * The cursor row is the discriminator, and it is the only one available.
   *
   * A row above or below the window is not in the document at all, so a test
   * cannot ask whether it was labelled. The cursor row IS in the document —
   * force-mounted so its highlight survives a disagreement about the offset —
   * and it is off screen. It is therefore the one row that can show the
   * difference between "labelled what is mounted" and "labelled what is
   * visible", and a query of `f0` matches it along with everything else.
   */
  it("labels rows that are on screen and not the mounted cursor row above them", async () => {
    const column = await openedLong();
    await scrollTo(column, 2400);

    press("s", "f", "0");

    await waitFor(() => expect(labelled().length).toBeGreaterThan(0));
    const cursorRow = within(column)
      .getAllByTestId("row")
      .find((row) => row.dataset["cursor"] === "true");
    // Without the narrowing it would carry the label `a`: it matches, and it is
    // the nearest row to the cursor, so it takes the head of the pool.
    expect(cursorRow?.textContent).toContain("f0000");
    expect(cursorRow?.dataset["flash"]).toBe("dim");
    expect(cursorRow?.querySelector(".row__flash-label")).toBeNull();
  });

  it("gives no label at all when every match is scrolled away", async () => {
    const column = await openedLong();
    await scrollTo(column, 2400);

    // f0000 through f0099 are all at the top of the listing, far above the
    // window. Every one of them matches, and none of them may be labelled.
    press("s", "f", "0", "0");

    // The query stops at "f00" and a further "0" is DROPPED, which is correct
    // and was the assertion this test got wrong at first: once nothing on
    // screen matches, no character can continue the query, so there is nothing
    // for a further keystroke to mean.
    await waitFor(() => expect(screen.getByTestId("status-flash").textContent).toContain("f00"));
    press("0");
    expect(screen.getByTestId("status-flash").textContent).toContain("f00");
    expect(labelled()).toEqual([]);
  });
});

// ── Guards ─────────────────────────────────────────────────────────────────
// Reclassified from a spec during the spec step: it passed on its first run,
// because a column that fits entirely on screen behaved this way before the
// narrowing existed. It pins that the narrowing did not break the ordinary case.

describe("a session over a short column", () => {
  it("treats every row as a candidate", async () => {
    render(<App startPath="/home/jc" />);
    await waitFor(() => expect(namesIn("column-current")).toContain("projects"));

    press("s", "n");

    // Both rows holding an `n` are labelled, and the listing is six rows in an
    // eight-hundred-pixel column — nothing is off screen to leave out.
    await waitFor(() => expect(labelled()).toHaveLength(2));
  });
});

describe("a scroll while a session is running", () => {
  it("neither ends the session nor disturbs the query", async () => {
    // ── What this guard does and does NOT pin ──────────────────────────────
    // Review found the candidate range being read LIVE, so a wheel scroll
    // between two keystrokes silently moved what the next character labelled —
    // a different feature from the one the plan settled. That was fixed by
    // freezing the range at `start()`.
    //
    // **The freeze itself is not observable through the DOM, and this test
    // does not claim to pin it.** Measured: reverting the fix leaves every
    // assertion here passing. The reason is that a frozen session's labels sit
    // on rows the scroll has unmounted, so they cannot be read; and the rows
    // that WOULD tell the two apart cannot be identified, because a labelled
    // row's name is overtyped and no longer contains its own index. What is
    // pinned here is the part that is observable: a scroll is not a key, so it
    // ends nothing and consumes nothing.
    const column = await openedLong();
    await scrollTo(column, 2400);

    press("s", "f", "0");
    await waitFor(() => expect(labelled().length).toBeGreaterThan(0));

    column.scrollTop = 5000;
    column.dispatchEvent(new Event("scroll"));
    await waitFor(() => expect(namesIn("column-current")).not.toContain("f0100.txt"));

    expect(screen.getByTestId("status-flash")).toBeTruthy();
    press("1");
    await waitFor(() => expect(screen.getByTestId("status-flash").textContent).toContain("f01"));
  });

  it("lets the NEXT session start from where the view now is", async () => {
    const column = await openedLong();
    await scrollTo(column, 2400);
    press("s", "f", "0");
    await waitFor(() => expect(labelled().length).toBeGreaterThan(0));

    column.scrollTop = 5000;
    column.dispatchEvent(new Event("scroll"));
    await waitFor(() => expect(namesIn("column-current")).not.toContain("f0100.txt"));
    press("Escape");
    await waitFor(() => expect(screen.queryByTestId("status-flash")).toBeNull());

    press("s", "f", "0", "2");

    // f0200-something is what the second scroll brought into view; the first
    // session could not have labelled any of it.
    await waitFor(() => expect(labelled().length).toBeGreaterThan(0));
    expect(labelled().every((name) => name.startsWith("f02"))).toBe(true);
  });
});
