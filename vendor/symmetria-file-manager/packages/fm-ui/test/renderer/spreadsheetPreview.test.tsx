/**
 * @vitest-environment happy-dom
 *
 * The spreadsheet branch: a grid, a tab per sheet, and what it says when it
 * cannot show everything.
 *
 * The worker is faked — the parsing it wraps has its own tests against real
 * workbooks in `spreadsheetWorker.test.ts`, and what is left to prove here is
 * the wiring: that the pane asks for the right sheet, draws what comes back,
 * discards what belongs to a file the cursor has left, and says so when a cap
 * was reached.
 *
 * Whether it reads the operator's 80 real `.xls` files is the verifier's, and
 * it is the question that decided the parser: nothing in this repository can
 * write legacy BIFF, so no test here can reach that path.
 */

import { BRIDGE_KEY, type Bridge } from "@symmetria/fm-core/bridge";
import { MAX_SHEET_COLUMNS, MAX_SHEET_ROWS } from "@symmetria/fm-core/preview/sheet";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PreviewPane } from "../../src/components/preview/PreviewPane.tsx";
import {
  forgetSpreadsheetWorker,
  SpreadsheetPreview,
} from "../../src/components/preview/SpreadsheetPreview.tsx";
import type { SheetRequest, SheetResponse } from "../../src/spreadsheet.worker.ts";
import { inertBridge } from "./support.ts";

const TOKEN_URL = "symmetria-fm://app/__preview/t";

/**
 * What the fake worker answers with, minus the id it echoes back.
 *
 * Distributed over the union rather than `Omit<SheetResponse, "id">`: `Omit`
 * collapses a discriminated union into a single member with a widened tag, so
 * the workbook branch's own fields disappear from the type.
 */
type AnswerBody = SheetResponse extends infer T
  ? T extends { id: number }
    ? Omit<T, "id">
    : never
  : never;

let answer: AnswerBody;
/** What it was asked for. */
let received: SheetRequest[] = [];
/** Whether it answers at all. */
let answering = true;

function grid(
  rows: readonly (readonly string[])[],
  truncatedRows = false,
  truncatedColumns = false,
) {
  return { rows, truncatedRows, truncatedColumns };
}

function workbookAnswer(
  sheetNames: readonly string[],
  rows: readonly (readonly string[])[],
  activeSheet = 0,
): AnswerBody {
  return { kind: "workbook", sheetNames, activeSheet, grid: grid(rows) };
}

class FakeWorker {
  private readonly listeners = new Set<(event: MessageEvent) => void>();

  addEventListener(_type: string, fn: (event: MessageEvent) => void) {
    this.listeners.add(fn);
  }

  removeEventListener(_type: string, fn: (event: MessageEvent) => void) {
    this.listeners.delete(fn);
  }

  postMessage(request: SheetRequest) {
    received.push(request);
    if (!answering) return;
    const data: SheetResponse = { ...answer, id: request.id };
    queueMicrotask(() => {
      for (const listener of [...this.listeners]) {
        listener(new MessageEvent("message", { data }));
      }
    });
  }

  terminate() {}
}

beforeEach(() => {
  received = [];
  answering = true;
  answer = workbookAnswer(
    ["Sheet1"],
    [
      ["Name", "Total"],
      ["Chini", "42"],
    ],
  );
  forgetSpreadsheetWorker();

  Object.defineProperty(globalThis, "Worker", {
    value: FakeWorker,
    configurable: true,
    writable: true,
  });

  const bridge: Bridge = {
    ...inertBridge(),
    previewUrl: () => Promise.resolve({ ok: true as const, value: { url: TOKEN_URL } }),
  };
  Object.defineProperty(window, BRIDGE_KEY, { value: bridge, configurable: true, writable: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  forgetSpreadsheetWorker();
});

function show(path = "/home/jc/Downloads/precios.xlsx") {
  return render(<SpreadsheetPreview path={path} mime="application/vnd.ms-excel" />);
}

function cellTexts(): string[] {
  return screen.getAllByTestId("preview-sheet-cell").map((cell) => cell.textContent ?? "");
}

describe("showing a workbook", () => {
  it("draws the cells it was given", async () => {
    show();

    await screen.findByTestId("preview-spreadsheet");
    await waitFor(() => expect(cellTexts()).toContain("Chini"));
    expect(cellTexts()).toContain("Total");
  });

  it("asks the worker for the file's own URL", async () => {
    show();

    await waitFor(() => expect(received.length).toBeGreaterThan(0));
    expect(received[0]?.url).toBe(TOKEN_URL);
  });

  it("asks for the first sheet to begin with", async () => {
    show();

    await waitFor(() => expect(received.length).toBeGreaterThan(0));
    expect(received[0]?.sheet).toBe(0);
  });
});

describe("the sheet tabs", () => {
  it("shows one per sheet", async () => {
    answer = workbookAnswer(["Enero", "Febrero", "Marzo"], [["x"]]);

    show();

    const tabs = await screen.findAllByTestId("preview-sheet-tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Enero", "Febrero", "Marzo"]);
  });

  it("marks the one being shown", async () => {
    answer = workbookAnswer(["A", "B"], [["x"]]);

    show();

    const tabs = await screen.findAllByTestId("preview-sheet-tab");
    expect(tabs[0]?.dataset.active).toBe("true");
    expect(tabs[1]?.dataset.active).toBeUndefined();
  });

  it("asks for another sheet when its tab is chosen", async () => {
    answer = workbookAnswer(["A", "B", "C"], [["x"]]);
    show();
    const tabs = await screen.findAllByTestId("preview-sheet-tab");

    answer = workbookAnswer(["A", "B", "C"], [["from B"]], 1);
    fireEvent.click(tabs[1] as HTMLElement);

    await waitFor(() => expect(received.at(-1)?.sheet).toBe(1));
    await waitFor(() => expect(cellTexts()).toContain("from B"));
  });

  it("shows no strip at all for a workbook with one sheet", async () => {
    // A single tab is a label pretending to be a control. The pane is narrow
    // and the row it would occupy is better spent on cells.
    show();

    await screen.findByTestId("preview-spreadsheet");
    expect(screen.queryByTestId("preview-sheet-tabs")).toBeNull();
  });

  it("survives a workbook with seventy-six of them", async () => {
    // Not hypothetical: one of the operator's own files. The strip scrolls
    // sideways rather than wrapping, so the grid keeps its height.
    const names = Array.from({ length: 76 }, (_, i) => `S${i}`);
    answer = workbookAnswer(names, [["x"]]);

    show();

    const tabs = await screen.findAllByTestId("preview-sheet-tab");
    expect(tabs).toHaveLength(76);
    const strip = screen.getByTestId("preview-sheet-tabs");
    expect(getComputedStyle(strip).flexWrap).not.toBe("wrap");
  });
});

describe("when the file changes", () => {
  it("goes back to the first sheet", async () => {
    // A sheet index left over from the previous workbook is either out of range
    // or silently pointing at a different sheet with the same number.
    answer = workbookAnswer(["A", "B"], [["x"]]);
    const view = show("/home/jc/first.xlsx");
    const tabs = await screen.findAllByTestId("preview-sheet-tab");
    fireEvent.click(tabs[1] as HTMLElement);
    await waitFor(() => expect(received.at(-1)?.sheet).toBe(1));

    view.rerender(
      <SpreadsheetPreview path="/home/jc/second.xlsx" mime="application/vnd.ms-excel" />,
    );

    await waitFor(() => expect(received.at(-1)?.sheet).toBe(0));
  });

  it("discards a workbook that belongs to the file the cursor left", async () => {
    // RE-rendered rather than rendered again: the cursor moving changes this
    // component's `path` prop, it does not mount a second pane. An earlier
    // version of this test called `show()` twice and then asserted against a
    // screen that still held the first one — the test failing for its own
    // reasons rather than the product's.
    const view = show("/home/jc/first.xlsx");
    await waitFor(() => expect(cellTexts()).toContain("Chini"));

    // The second file's answer never comes, so anything still on screen would
    // be the first file's cells under the second file's name.
    answering = false;
    view.rerender(
      <SpreadsheetPreview path="/home/jc/second.xlsx" mime="application/vnd.ms-excel" />,
    );

    await waitFor(() => expect(screen.queryByText("Chini")).toBeNull());
    expect(await screen.findByTestId("preview-loading")).toBeTruthy();
  });
});

describe("what it says when it cannot show everything", () => {
  it("states that rows were dropped", async () => {
    answer = {
      kind: "workbook",
      sheetNames: ["S"],
      activeSheet: 0,
      grid: grid([["a"]], true, false),
    };

    show();

    const notice = await screen.findByTestId("preview-sheet-truncated");
    expect(notice.textContent).toMatch(new RegExp(String(MAX_SHEET_ROWS)));
  });

  it("states that columns were dropped, separately", async () => {
    answer = {
      kind: "workbook",
      sheetNames: ["S"],
      activeSheet: 0,
      grid: grid([["a"]], false, true),
    };

    show();

    const notice = await screen.findByTestId("preview-sheet-truncated");
    expect(notice.textContent).toMatch(new RegExp(String(MAX_SHEET_COLUMNS)));
  });

  it("says nothing when nothing was dropped", async () => {
    show();

    await screen.findByTestId("preview-spreadsheet");
    expect(screen.queryByTestId("preview-sheet-truncated")).toBeNull();
  });
});

describe("when it cannot be read", () => {
  it("shows a readable notice rather than an empty pane", async () => {
    answer = { kind: "unreadable" };

    show();

    const failed = await screen.findByTestId("preview-sheet-failed");
    expect(failed.textContent?.length ?? 0).toBeGreaterThan(0);
  });

  it("shows a reading state while the answer is in flight", async () => {
    answering = false;

    show();

    expect(await screen.findByTestId("preview-loading")).toBeTruthy();
  });

  it("shows a notice when the host has no workers at all", async () => {
    // The panel is embeddable. Unlike a waveform, a spreadsheet has nothing to
    // fall back to — the grid IS the preview — so it says so rather than
    // showing an empty pane forever.
    forgetSpreadsheetWorker();
    Object.defineProperty(globalThis, "Worker", { value: undefined, configurable: true });

    show();

    expect(await screen.findByTestId("preview-sheet-failed")).toBeTruthy();
  });
});

describe("the pane routes to it", () => {
  it("is what a spreadsheet route reaches for", async () => {
    render(
      <PreviewPane
        route={{ kind: "spreadsheet", mime: "application/vnd.ms-excel" }}
        path="/home/jc/Downloads/precios.xls"
        size={657_000}
      />,
    );

    expect(screen.getByTestId("column-preview").dataset.kind).toBe("spreadsheet");
    expect(await screen.findByTestId("preview-spreadsheet")).toBeTruthy();
  });

  it("no longer offers the unbuilt apology for a spreadsheet", () => {
    render(
      <PreviewPane
        route={{ kind: "spreadsheet", mime: "text/csv" }}
        path="/home/jc/Downloads/lista.csv"
        size={4096}
      />,
    );

    expect(screen.queryByTestId("preview-unbuilt")).toBeNull();
  });
});

describe("a large sheet", () => {
  it("mounts far fewer rows than it holds", async () => {
    // Virtualised: two hundred rows of fifty cells is ten thousand elements if
    // every one is mounted, on a pane a few hundred pixels tall.
    const rows = Array.from({ length: MAX_SHEET_ROWS }, (_, r) => [`r${r}`, "b", "c"]);
    answer = workbookAnswer(["S"], rows);

    show();

    await waitFor(() =>
      expect(screen.getAllByTestId("preview-sheet-row").length).toBeGreaterThan(0),
    );
    expect(screen.getAllByTestId("preview-sheet-row").length).toBeLessThan(MAX_SHEET_ROWS);
  });
});

describe("guards", () => {
  it("keeps the tab strip on screen while another sheet loads", async () => {
    // Review found this and no test could have: with a fake worker the answer
    // arrives in a microtask, so the blank never renders. Against a real parse
    // — 23 ms for one sheet, measured — reverting to the reading state swaps
    // the whole pane for a message, and the tab the user just clicked vanishes
    // under their cursor.
    answer = workbookAnswer(["A", "B", "C"], [["x"]]);
    show();
    const tabs = await screen.findAllByTestId("preview-sheet-tab");

    // The next sheet's answer never comes, so whatever is on screen after the
    // click is what a slow parse would show.
    answering = false;
    fireEvent.click(tabs[2] as HTMLElement);

    await waitFor(() => expect(received.at(-1)?.sheet).toBe(2));
    expect(screen.getAllByTestId("preview-sheet-tab")).toHaveLength(3);
    expect(screen.queryByTestId("preview-loading")).toBeNull();
  });

  it("does clear everything when the FILE changes, not just the sheet", async () => {
    // The other half of the same rule: a tab strip belonging to the previous
    // workbook must not survive a move to a different file.
    answer = workbookAnswer(["A", "B"], [["x"]]);
    const view = show("/home/jc/first.xlsx");
    await screen.findAllByTestId("preview-sheet-tab");

    answering = false;
    view.rerender(
      <SpreadsheetPreview path="/home/jc/second.xlsx" mime="application/vnd.ms-excel" />,
    );

    await waitFor(() => expect(screen.queryByTestId("preview-sheet-tab")).toBeNull());
    expect(await screen.findByTestId("preview-loading")).toBeTruthy();
  });

  it("gives a column of long text more room than a column of short codes", async () => {
    // A fixed narrow column ellipsised real description columns down to five
    // or six characters, which verification found against the operator's own
    // files. Widths come from the content, clamped at both ends.
    answer = workbookAnswer(
      ["S"],
      [
        ["id", "a fairly long description of the product"],
        ["1", "another long description that needs room"],
      ],
    );

    show();

    await waitFor(() =>
      expect(screen.getAllByTestId("preview-sheet-cell").length).toBeGreaterThan(0),
    );
    const cells = screen.getAllByTestId("preview-sheet-cell");
    const narrow = Number.parseInt((cells[0] as HTMLElement).style.width, 10);
    const wide = Number.parseInt((cells[1] as HTMLElement).style.width, 10);

    expect(wide).toBeGreaterThan(narrow);
  });

  it("never makes a column wider than the pane can carry", async () => {
    // Clamped: one enormous cell must not push every other column off the edge.
    answer = workbookAnswer(["S"], [["short", "x".repeat(500)]]);

    show();

    await waitFor(() =>
      expect(screen.getAllByTestId("preview-sheet-cell").length).toBeGreaterThan(0),
    );
    const wide = screen.getAllByTestId("preview-sheet-cell")[1] as HTMLElement;
    expect(Number.parseInt(wide.style.width, 10)).toBeLessThanOrEqual(24);
  });

  it("announces the tabs as a tablist", async () => {
    answer = workbookAnswer(["A", "B"], [["x"]]);

    show();

    const tabs = await screen.findAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("false");
  });
});
