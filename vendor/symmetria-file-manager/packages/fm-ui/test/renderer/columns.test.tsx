/**
 * @vitest-environment happy-dom
 *
 * Declared per file rather than by a config glob. `environmentMatchGlobs` is
 * gone in Vitest 4 and failed silently — every renderer test died on
 * `document is not defined` while the config looked correct. A docblock is
 * local to the file that needs it and cannot drift out of a config.
 *
 * The main-process tests deliberately do NOT get a DOM, so a stray `document`
 * in privileged code fails loudly here instead of working in a test and
 * crashing in production.
 */
import type { FsEntry } from "@symmetria/fm-core/entry";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MillerColumns } from "../../src/components/MillerColumns.tsx";
import { PathBar } from "../../src/components/PathBar.tsx";
import { StatusBar } from "../../src/components/StatusBar.tsx";
import { INITIAL_RECT, observeWithFallback } from "../../src/components/virtualize.ts";

afterEach(cleanup);

function entry(name: string, kind: FsEntry["kind"] = "file"): FsEntry {
  return { name, kind, size: 0, modifiedMs: 0, isSymlink: false, isHidden: false };
}

const parent = [entry("jc", "directory"), entry("other", "directory")];
const current = [entry("src", "directory"), entry("a.txt"), entry("b.txt")];

describe("MillerColumns", () => {
  it("renders three columns: parent, current and preview", () => {
    render(
      <MillerColumns
        path="/home/jc"
        parentEntries={parent}
        entries={current}
        cursorIndex={0}
        parentCursorName="jc"
      />,
    );

    expect(screen.getByTestId("column-parent")).toBeDefined();
    expect(screen.getByTestId("column-current")).toBeDefined();
    expect(screen.getByTestId("column-preview")).toBeDefined();
  });

  it("lists the current directory's entries", () => {
    render(
      <MillerColumns
        path="/home/jc"
        parentEntries={parent}
        entries={current}
        cursorIndex={0}
        parentCursorName="jc"
      />,
    );

    const column = screen.getByTestId("column-current");
    expect(within(column).getByText("a.txt")).toBeDefined();
    expect(within(column).getByText("b.txt")).toBeDefined();
  });

  it("marks exactly one row as the cursor", () => {
    render(
      <MillerColumns
        path="/home/jc"
        parentEntries={parent}
        entries={current}
        cursorIndex={1}
        parentCursorName="jc"
      />,
    );

    const column = screen.getByTestId("column-current");
    const marked = column.querySelectorAll('[data-cursor="true"]');
    expect(marked).toHaveLength(1);
    expect(marked[0]?.textContent).toContain("a.txt");
  });

  it("shows which entry the parent column is sitting on", () => {
    render(
      <MillerColumns
        path="/home/jc"
        parentEntries={parent}
        entries={current}
        cursorIndex={0}
        parentCursorName="jc"
      />,
    );

    const column = screen.getByTestId("column-parent");
    expect(column.querySelector('[data-cursor="true"]')?.textContent).toContain("jc");
  });

  it("says an empty directory is empty rather than rendering nothing", () => {
    render(
      <MillerColumns
        path="/tmp/empty"
        parentEntries={parent}
        entries={[]}
        cursorIndex={0}
        parentCursorName="jc"
      />,
    );

    expect(within(screen.getByTestId("column-current")).getByText(/empty/i)).toBeDefined();
  });
});

describe("MillerColumns at scale", () => {
  it("does not mount ten thousand rows", () => {
    // Virtualisation is necessary and NOT sufficient — the measured lesson from
    // the Qt tree is that the dominant cost was the NUMBER of directories
    // expanded, not the cost of each row. Miller columns are safe by
    // construction because they show three levels and never expand a subtree,
    // and decision D5 removed auto-expansion entirely. This test guards the
    // row-mounting half of it.
    const many = Array.from({ length: 10_000 }, (_, i) => entry(`entry-${i}.txt`));

    render(
      <MillerColumns
        path="/big"
        parentEntries={parent}
        entries={many}
        cursorIndex={0}
        parentCursorName="jc"
      />,
    );

    // `/^row-/` was the bug: it does not match the literal id `row`, so this
    // collected ONLY the cursor row and passed whatever the virtualiser did.
    const rows = within(screen.getByTestId("column-current")).getAllByTestId("row");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(200);
  });

  it("mounts the cursor row even when it is far outside the visible window", () => {
    // The regression this pins. Following the cursor used to call
    // `virtualizer.scrollToIndex`, whose programmatic scroll races the
    // virtualiser's own scroll listener: holding `j` left the container
    // scrolled near the bottom while the virtualiser still believed the offset
    // was zero, so it rendered the rows at the top, the cursor was not among
    // them, and the highlight vanished with no way back. Verified in real
    // Chromium — a headless DOM has no scrolling and cannot reproduce the race.
    //
    // The `rangeExtractor` makes the cursor row's presence independent of the
    // scroll position entirely, so the worst case is a row briefly off screen
    // rather than a list with no cursor. Do NOT remove it as redundant.
    const many = Array.from({ length: 10_000 }, (_, i) => entry(`entry-${i}.txt`));

    render(
      <MillerColumns
        path="/big"
        parentEntries={parent}
        entries={many}
        cursorIndex={9000}
        parentCursorName="jc"
      />,
    );

    const column = screen.getByTestId("column-current");
    const marked = column.querySelectorAll('[data-cursor="true"]');
    expect(marked).toHaveLength(1);
    expect(marked[0]?.textContent).toContain("entry-9000.txt");
    // Still bounded: one extra row, not the ten thousand between here and there.
    expect(within(column).getAllByTestId("row").length).toBeLessThan(200);
  });
});

describe("PathBar", () => {
  it("shows the location as breadcrumb segments", () => {
    render(<PathBar path="/home/jc/projects" />);

    const bar = screen.getByTestId("path-bar");
    expect(within(bar).getByText("home")).toBeDefined();
    expect(within(bar).getByText("jc")).toBeDefined();
    expect(within(bar).getByText("projects")).toBeDefined();
  });

  it("marks the last segment as the current one", () => {
    render(<PathBar path="/home/jc/projects" />);

    expect(screen.getByTestId("crumb-current").textContent).toBe("projects");
  });
});

/**
 * The bar now takes the search field and the transient line as well, because
 * both used to be rows of their own above and below the columns. These three
 * assertions are about the counts, so both are handed over empty.
 */
const QUIET = { error: null, message: null, progress: null, onCancelTransfer: () => {} };

describe("StatusBar", () => {
  it("shows the entry count, the selection count and the sort mode", () => {
    render(
      <StatusBar
        picker={null}
        entryCount={42}
        selectedCount={3}
        sort="natural"
        reverse={false}
        showHidden={false}
        search={null}
        transient={QUIET}
      />,
    );

    const bar = screen.getByTestId("status-bar");
    expect(bar.textContent).toContain("42");
    expect(bar.textContent).toContain("3");
    expect(bar.textContent).toContain("natural");
  });

  it("says nothing about a selection when there is none", () => {
    render(
      <StatusBar
        picker={null}
        entryCount={42}
        selectedCount={0}
        sort="alphabetical"
        reverse={false}
        showHidden={false}
        search={null}
        transient={QUIET}
      />,
    );

    expect(screen.getByTestId("status-bar").textContent).not.toMatch(/selected/i);
  });

  it("says when hidden files are shown, because it changes what the count means", () => {
    render(
      <StatusBar
        picker={null}
        entryCount={42}
        selectedCount={0}
        sort="alphabetical"
        reverse={false}
        showHidden={true}
        search={null}
        transient={QUIET}
      />,
    );

    expect(screen.getByTestId("status-bar").textContent).toMatch(/hidden/i);
  });
});

describe("observeWithFallback", () => {
  // A whole DOMRect, not `{width, height} as unknown as DOMRect`. The chained
  // assertion told the compiler a two-key object was a DOMRect; if the code
  // under test ever reads `.top`, the test would hand it `undefined` while
  // still type-checking. Building the real shape keeps the stub honest.
  function elementReporting(height: number): HTMLDivElement {
    const element = document.createElement("div");
    const rect: DOMRect = {
      x: 0,
      y: 0,
      width: 321,
      height,
      top: 0,
      right: 321,
      bottom: height,
      left: 0,
      toJSON: () => ({ width: 321, height }),
    };
    element.getBoundingClientRect = () => rect;
    return element;
  }

  it("reports a real measurement when there is one", () => {
    // The claim the docstring makes and nothing proved: the fallback applies
    // ONLY when the measurement is degenerate. Without this, every rendered
    // test ran against a fabricated viewport and the real path was untested.
    const seen: { width: number; height: number }[] = [];
    observeWithFallback({ scrollElement: elementReporting(600) }, (rect) => seen.push(rect));

    expect(seen[0]).toEqual({ width: 321, height: 600 });
  });

  it("falls back only when the element measures zero", () => {
    const seen: { width: number; height: number }[] = [];
    observeWithFallback({ scrollElement: elementReporting(0) }, (rect) => seen.push(rect));

    expect(seen[0]).toEqual(INITIAL_RECT);
  });

  it("falls back when there is no element at all", () => {
    const seen: { width: number; height: number }[] = [];
    observeWithFallback({ scrollElement: null }, (rect) => seen.push(rect));

    expect(seen[0]).toEqual(INITIAL_RECT);
  });
});

describe("MillerColumns, a parent entry that is gone", () => {
  it("highlights nothing rather than claiming entry zero is where you are", () => {
    render(
      <MillerColumns
        path="/home/jc"
        parentEntries={parent}
        entries={current}
        cursorIndex={0}
        parentCursorName="renamed-away"
      />,
    );

    const column = screen.getByTestId("column-parent");
    expect(column.querySelectorAll('[data-cursor="true"]')).toHaveLength(0);
  });
});
