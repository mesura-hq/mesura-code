/**
 * @vitest-environment happy-dom
 *
 * The archive branch: an indented listing, its counts, and what it says when
 * it cannot show everything.
 *
 * The worker is faked. The reading it wraps has its own tests — against real
 * archives in `fm-core`, and against a real zip and a real gzip in
 * `archiveWorker.test.ts` — so what is left to prove here is the wiring: that
 * the pane asks for the right file, draws what comes back, discards what
 * belongs to a file the cursor has left, and stays cheap at five thousand rows.
 */

import { BRIDGE_KEY, type Bridge } from "@symmetria/fm-core/bridge";
import type { ArchiveListing, ArchiveRow } from "@symmetria/fm-core/preview/archive/listing";
import { MAX_ARCHIVE_ENTRIES } from "@symmetria/fm-core/preview/archive/types";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ArchiveRequest, ArchiveResponse } from "../../src/archive.worker.ts";
import {
  ArchivePreview,
  forgetArchiveWorker,
} from "../../src/components/preview/ArchivePreview.tsx";
import { PreviewPane } from "../../src/components/preview/PreviewPane.tsx";
import { inertBridge } from "./support.ts";

const TOKEN_URL = "symmetria-fm://app/__preview/t";

type AnswerBody = ArchiveResponse extends infer T
  ? T extends { id: number }
    ? Omit<T, "id">
    : never
  : never;

let answer: AnswerBody;
let received: ArchiveRequest[] = [];
let answering = true;
/** Which request gets which answer. Overridden only where a test needs two panes. */
let answerFor: (request: ArchiveRequest) => AnswerBody | null = () => answer;

function row(path: string, depth: number, isDirectory: boolean, size = 0): ArchiveRow {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return { path, name, depth, isDirectory, size };
}

function listing(rows: readonly ArchiveRow[], over: Partial<ArchiveListing> = {}): ArchiveListing {
  return {
    rows,
    truncated: false,
    totalRows: rows.length,
    dirCount: rows.filter((entry) => entry.isDirectory).length,
    fileCount: rows.filter((entry) => !entry.isDirectory).length,
    ...over,
  };
}

function listed(rows: readonly ArchiveRow[], over: Partial<ArchiveListing> = {}): AnswerBody {
  return { kind: "listing", listing: listing(rows, over), partial: false };
}

class FakeWorker {
  private readonly listeners = new Set<(event: MessageEvent) => void>();

  addEventListener(_type: string, fn: (event: MessageEvent) => void) {
    this.listeners.add(fn);
  }

  removeEventListener(_type: string, fn: (event: MessageEvent) => void) {
    this.listeners.delete(fn);
  }

  postMessage(request: ArchiveRequest) {
    received.push(request);
    if (!answering) return;

    const body = answerFor(request);
    if (body === null) return;

    // Broadcast to EVERY listener, which is what the real shared worker does
    // and is the whole reason each answer carries the id it is replying to.
    const data: ArchiveResponse = { ...body, id: request.id };
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
  answer = listed([]);
  answerFor = () => answer;
  forgetArchiveWorker();

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
  forgetArchiveWorker();
});

describe("the archive pane", () => {
  it("draws one row per entry, indented by depth, sized only for files", async () => {
    answer = listed([
      row("game", 0, true),
      row("game/data.rpa", 1, false, 1_400_000_000),
      row("script_version.txt", 0, false, 9),
    ]);

    render(<ArchivePreview path="/tmp/a.zip" format="zip" compression="none" size={4096} />);

    await waitFor(() => expect(screen.getAllByTestId("preview-archive-row")).toHaveLength(3));
    const rows = screen.getAllByTestId("preview-archive-row");

    expect(rows.map((element) => element.getAttribute("data-depth"))).toEqual(["0", "1", "0"]);
    // A folder has no size beside it. The Qt build shows none either, and a
    // zero would read as an empty folder rather than as a folder.
    expect(rows[0]?.querySelector('[data-testid="preview-archive-size"]')).toBeNull();
    expect(rows[1]?.querySelector('[data-testid="preview-archive-size"]')?.textContent).toContain(
      "1.3",
    );
  });

  it("says how many folders and how many files the archive holds", async () => {
    answer = listed([row("a", 0, true), row("a/one.bin", 1, false, 5)], {
      dirCount: 120,
      fileCount: 1369,
    });

    render(<ArchivePreview path="/tmp/a.zip" format="zip" compression="none" size={4096} />);

    await waitFor(() =>
      expect(screen.getByTestId("preview-archive-counts").textContent).toBe("120 dirs, 1369 files"),
    );
  });

  it("says how many of the total are on screen when it cannot show them all", async () => {
    answer = listed([row("a.bin", 0, false, 1)], { truncated: true, totalRows: 6001 });

    render(<ArchivePreview path="/tmp/a.zip" format="zip" compression="none" size={4096} />);

    await waitFor(() => {
      const notice = screen.getByTestId("preview-archive-truncated").textContent ?? "";
      expect(notice).toContain("6001");
    });
  });

  it("shows a notice rather than an empty pane when the archive cannot be read", async () => {
    answer = { kind: "unreadable" };

    render(<ArchivePreview path="/tmp/a.zip" format="zip" compression="none" size={4096} />);

    await waitFor(() => expect(screen.getByTestId("preview-archive-failed")).toBeTruthy());
    expect(screen.queryByTestId("preview-archive-row")).toBeNull();
  });

  it("does not let one pane render the answer meant for another", async () => {
    // **The worker is SHARED**, so two panes on screen at once both receive
    // every answer it sends. That is the only case where a stale id reaches a
    // LIVE listener — and it is what the Miller pane plus the finder's info
    // pane will be. A first version of this test rendered one pane and changed
    // its path, which the effect cleanup already handles on its own: deleting
    // the id check entirely broke nothing.
    answer = listed([row("belongs-to-the-second.bin", 0, false, 1)]);
    answerFor = () => (received.length === 2 ? answer : null);

    render(
      <>
        <div data-testid="pane-one">
          <ArchivePreview path="/tmp/one.zip" format="zip" compression="none" size={4096} />
        </div>
        <div data-testid="pane-two">
          <ArchivePreview path="/tmp/two.zip" format="zip" compression="none" size={4096} />
        </div>
      </>,
    );

    await waitFor(() => expect(received).toHaveLength(2));
    await waitFor(() =>
      expect(
        within(screen.getByTestId("pane-two")).getAllByTestId("preview-archive-row"),
      ).toHaveLength(1),
    );

    // The first pane was never answered and must still be waiting, not showing
    // the second pane's archive.
    expect(within(screen.getByTestId("pane-one")).getByTestId("preview-loading")).toBeTruthy();
    expect(within(screen.getByTestId("pane-one")).queryByTestId("preview-archive-row")).toBeNull();
  });

  it("stops listening for a file the cursor has left", async () => {
    answering = false;
    const view = render(
      <ArchivePreview path="/tmp/first.zip" format="zip" compression="none" size={4096} />,
    );
    await waitFor(() => expect(received).toHaveLength(1));

    answering = true;
    answer = listed([row("second-only.bin", 0, false, 1)]);
    view.rerender(
      <ArchivePreview path="/tmp/second.zip" format="zip" compression="none" size={4096} />,
    );

    await waitFor(() => expect(screen.getAllByTestId("preview-archive-row")).toHaveLength(1));

    // The first request was never answered; had its id not been checked, the
    // late answer for `first.zip` would have replaced the second file's rows.
    expect(received).toHaveLength(2);
    expect(received[1]?.id).not.toBe(received[0]?.id);
  });

  it("renders five thousand rows without mounting five thousand elements", async () => {
    const rows: ArchiveRow[] = [];
    for (let i = 0; i < MAX_ARCHIVE_ENTRIES; i++) rows.push(row(`bulk/f${i}.bin`, 1, false, i));
    answer = listed(rows, { truncated: true, totalRows: 6001 });

    render(<ArchivePreview path="/tmp/big.zip" format="zip" compression="none" size={4096} />);

    await waitFor(() =>
      expect(screen.getAllByTestId("preview-archive-row").length).toBeGreaterThan(0),
    );
    expect(screen.getAllByTestId("preview-archive-row").length).toBeLessThan(200);
  });

  it("is what the preview router's archive branch draws", async () => {
    answer = listed([row("inside.txt", 0, false, 4)]);

    render(
      <PreviewPane
        route={{ kind: "archive", mime: "application/zip", format: "zip", compression: "none" }}
        path="/tmp/a.zip"
        size={4096}
      />,
    );

    await waitFor(() => expect(screen.getAllByTestId("preview-archive-row")).toHaveLength(1));
    expect(received[0]?.format).toBe("zip");
  });
});

/**
 * Things that were wrong once.
 *
 * The first came from this phase's review: a top-level row lost the horizontal
 * inset every other `.row` in the application has, because an inline
 * `paddingLeft` of zero — which is what depth 0 computes to — overrides the
 * class that sets it. The rest pin the failure paths, which only the real
 * application had exercised until now.
 */
describe("the archive pane, on the shapes that were wrong", () => {
  it("indents with a spacer, so a top-level row keeps the row inset", () => {
    answer = listed([row("top.txt", 0, false, 1), row("a/nested.txt", 2, false, 2)]);

    render(<ArchivePreview path="/tmp/a.zip" format="zip" compression="none" size={4096} />);

    return waitFor(() => {
      const rows = screen.getAllByTestId("preview-archive-row");
      // Depth 0 carries NO spacer at all, so nothing overrides `.row`.
      expect(rows[0]?.querySelector(".preview__archive-indent")).toBeNull();
      // And the row itself sets no inline padding, at any depth.
      expect(rows[0]?.style.paddingLeft).toBe("");
      expect(rows[1]?.style.paddingLeft).toBe("");
      // SAFETY: `querySelector` is typed `Element | null`, and only an
      // `HTMLElement` carries `style`. The selector matches a `<span>` this
      // component renders, so the cast narrows to what the DOM already holds.
      const spacer = rows[1]?.querySelector(".preview__archive-indent") as HTMLElement | null;
      expect(spacer?.style.width).toBe("36px");
    });
  });

  it("says the counts are a floor when the reader stopped early", async () => {
    // A tar has no index, so a walk that hit its bound does not know the rest.
    // Printing its counts plainly would state a floor as a total.
    answer = { kind: "listing", listing: listing([row("a.bin", 0, false, 1)]), partial: true };

    render(<ArchivePreview path="/tmp/a.tar" format="tar" compression="none" size={4096} />);

    await waitFor(() =>
      expect(screen.getByTestId("preview-archive-counts").textContent).toContain("or more"),
    );
  });

  it("asks the worker for the compression the router chose", async () => {
    answer = listed([row("a.bin", 0, false, 1)]);

    render(<ArchivePreview path="/tmp/a.tar.gz" format="tar" compression="gzip" size={4096} />);

    // The defect verification found lived one layer up, in the MIME table that
    // decides this value — but the pane passing it through is what makes that
    // table's answer reach the reader at all.
    await waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.compression).toBe("gzip");
    expect(received[0]?.size).toBe(4096);
  });

  it("shows a notice when the host has no workers at all", async () => {
    // The panel is embeddable and `Worker` may simply not be there. Unlike a
    // waveform there is no lesser thing to draw — the listing IS the preview.
    forgetArchiveWorker();
    Object.defineProperty(globalThis, "Worker", {
      value: undefined,
      configurable: true,
      writable: true,
    });

    render(<ArchivePreview path="/tmp/a.zip" format="zip" compression="none" size={4096} />);

    await waitFor(() => expect(screen.getByTestId("preview-archive-failed")).toBeTruthy());
  });
});
