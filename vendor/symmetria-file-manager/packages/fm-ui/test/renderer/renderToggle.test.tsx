/**
 * @vitest-environment happy-dom
 *
 * One key, both rendered views, and a choice that outlives the window.
 *
 * The mode is deliberately NOT per file. It is one flag in the same store that
 * already holds the sort order and hidden-file visibility, which is what makes
 * "switch to source and keep reading" work across a whole directory instead of
 * one row — and what makes it survive a restart. Most of what is asserted here
 * is that consequence rather than the key press itself.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../../src/App.tsx";
import { type BridgeLog, cursorIn, installBridge, namesIn } from "./support.ts";

let log: BridgeLog;

beforeEach(() => {
  log = installBridge();
});
afterEach(cleanup);

/** Open on the fixture home and put the cursor on the markdown file. */
async function onMarkdown(): Promise<void> {
  render(<App startPath="/home/jc" />);
  await waitFor(() => expect(namesIn("column-current")).toContain("projects"));
  fireEvent.keyDown(window, { key: "l" });
  await waitFor(() => expect(namesIn("column-current")).toContain("beta.md"));
  fireEvent.keyDown(window, { key: "j" });
  await waitFor(() => expect(cursorIn("column-current")).toContain("beta.md"));
  await screen.findByTestId("preview-markdown");
}

const renderToggle = () => fireEvent.keyDown(window, { key: "r", ctrlKey: true });

describe("the key", () => {
  it("swaps the rendered document for its source, and back again", async () => {
    await onMarkdown();

    renderToggle();
    expect(await screen.findByTestId("preview-code")).toBeDefined();
    expect(screen.queryByTestId("preview-markdown")).toBeNull();

    renderToggle();
    expect(await screen.findByTestId("preview-markdown")).toBeDefined();
    expect(screen.queryByTestId("preview-code")).toBeNull();
  });

  it("shows the source with its highlighting language intact", async () => {
    // Switching off rendering must not be a downgrade to uncoloured text. The
    // router's language answer is still there; only the presentation changed.
    await onMarkdown();
    renderToggle();

    expect((await screen.findByTestId("preview-code")).dataset.language).toBe("markdown");
  });
});

describe("what is remembered", () => {
  it("writes the choice to the same store as the sort order", async () => {
    await onMarkdown();
    renderToggle();

    await waitFor(() => expect(log.listingWrites.length).toBeGreaterThan(0));
    expect(log.listingWrites[log.listingWrites.length - 1]?.renderDocuments).toBe(false);
  });

  it("leaves the sort order alone when it writes", async () => {
    // One store, four fields. A toggle that rewrote the others would silently
    // reset an order the operator chose.
    await onMarkdown();
    renderToggle();

    await waitFor(() => expect(log.listingWrites.length).toBeGreaterThan(0));
    const written = log.listingWrites[log.listingWrites.length - 1];
    expect(written?.sort).toBe("modified");
    expect(written?.reverse).toBe(true);
  });

  it("opens on source when the store says source", async () => {
    // THE assertion that the setting is real. A mode that toggled but was
    // never read back would look like it worked and forget every restart.
    log = installBridge({
      storedListing: {
        sort: "modified",
        reverse: true,
        showHidden: false,
        renderDocuments: false,
      },
    });
    render(<App startPath="/home/jc" />);
    await waitFor(() => expect(namesIn("column-current")).toContain("projects"));
    fireEvent.keyDown(window, { key: "l" });
    await waitFor(() => expect(namesIn("column-current")).toContain("beta.md"));
    fireEvent.keyDown(window, { key: "j" });

    expect(await screen.findByTestId("preview-code")).toBeDefined();
    expect(screen.queryByTestId("preview-markdown")).toBeNull();
  });

  it("does not re-list the directory when only the render mode changed", async () => {
    // The flag decides how a file is DRAWN, not which entries a listing holds.
    // Re-listing on it would make the pane flicker on a key that has nothing to
    // do with the listing.
    await onMarkdown();
    const before = log.listed.length;

    renderToggle();
    await waitFor(() => expect(log.listingWrites.length).toBeGreaterThan(0));

    expect(log.listed.length).toBe(before);
  });
});

describe("the indicator in the status line", () => {
  // It began as a badge drawn over the preview and the operator moved it here.
  // An indicator on top of the document either covers its first line — which
  // for a markdown file is its title, as verification found — or costs a strip
  // of every preview to avoid doing so. The bar already exists at a fixed
  // height and already carries the sort order and the hidden-file state.
  const indicator = () => screen.queryByTestId("status-render-mode");

  it("names the mode, and the key that changes it", async () => {
    await onMarkdown();
    renderToggle();

    await waitFor(() => expect(indicator()?.textContent).toMatch(/source/i));
    expect(indicator()?.textContent).toContain("⌃r");
  });

  it("shows the rendered mode too, so the state is never implicit", async () => {
    // Only saying something when rendering is OFF would make the ordinary state
    // the one with no evidence, and a reader could not then tell "rendered"
    // from "this file has no rendered form".
    await onMarkdown();

    await waitFor(() => expect(indicator()?.textContent).toMatch(/rendered/i));
  });

  it("draws the key as a keycap rather than as another status word", async () => {
    await onMarkdown();

    await waitFor(() => expect(indicator()).not.toBeNull());
    expect(indicator()?.querySelector("kbd")?.textContent).toBe("⌃r");
  });

  it("says nothing at all for a file with no rendered form", async () => {
    // Most of what a cursor passes over. The indicator is absent almost always,
    // which is what makes it worth reading when it is there.
    render(<App startPath="/home/jc" />);
    await waitFor(() => expect(namesIn("column-current")).toContain("notes.txt"));
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(cursorIn("column-current")).toContain("notes.txt"));
    await screen.findByTestId("preview-text");

    expect(indicator()).toBeNull();
  });
});
