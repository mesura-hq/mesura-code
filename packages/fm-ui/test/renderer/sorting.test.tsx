/**
 * @vitest-environment happy-dom
 *
 * Choosing an order, and showing dotfiles.
 *
 * **What is proved here is the REQUEST, not the ordering.** Both are decided by
 * the main process, which sorts and filters before it answers — so the thing the
 * renderer can be held to is that it asks for what the user chose, on every
 * listing, for as long as the choice stands. The ordering itself is proved
 * against the real handler in `app/test/ipc.test.ts` and against the comparators
 * in the shared package's own suite.
 *
 * The fixture returns its stored order verbatim and deliberately does not sort.
 * Making it sort was tried and reverted: `/home/jc` puts files between
 * directories, which no real listing ever does, and forty existing tests count
 * `j` presses against that shape.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../../src/App.tsx";
import { type BridgeLog, installBridge, type ListAsk, namesIn } from "./support.ts";

let log: BridgeLog;

beforeEach(() => {
  log = installBridge();
});
afterEach(cleanup);

async function opened(at = "/home/jc"): Promise<void> {
  render(<App startPath={at} />);
  await waitFor(() => expect(namesIn("column-current").length).toBeGreaterThan(0));
  await act(async () => undefined);
}

/** Two separate keys, as a person presses them. */
function press(...keys: string[]): void {
  for (const key of keys) fireEvent.keyDown(window, { key });
}

/** A capital, which is how a reversed order is asked for. */
function pressShift(key: string): void {
  fireEvent.keyDown(window, { key, shiftKey: true });
}

/** The most recent listing of a given path. */
function lastAskFor(path: string): ListAsk | undefined {
  return [...log.listAsks].reverse().find((ask) => ask.path === path);
}

describe("choosing an order with the comma chord", () => {
  it("asks for the size order, and says so in the status bar", async () => {
    await opened();

    press(",", "s");

    await waitFor(() => expect(lastAskFor("/home/jc")?.sort).toBe("size"));
    expect(lastAskFor("/home/jc")?.reverse).toBe(false);
    expect(screen.getByTestId("status-bar").textContent).toMatch(/size/i);
  });

  it("reverses the order when the letter is a capital", async () => {
    await opened();

    press(",");
    pressShift("S");

    await waitFor(() => expect(lastAskFor("/home/jc")?.reverse).toBe(true));
    expect(lastAskFor("/home/jc")?.sort).toBe("size");
  });

  it("offers all five orders, each on its own letter", async () => {
    await opened();

    for (const [key, mode] of [
      ["a", "alphabetical"],
      ["m", "modified"],
      ["e", "extension"],
      ["n", "natural"],
      ["s", "size"],
    ] as const) {
      press(",", key);
      await waitFor(() => expect(lastAskFor("/home/jc")?.sort).toBe(mode));
    }
  });
});

describe("showing hidden files with the full stop", () => {
  it("asks for them, and asks again to stop", async () => {
    await opened();

    press(".");
    await waitFor(() => expect(lastAskFor("/home/jc")?.showHidden).toBe(true));

    press(".");
    await waitFor(() => expect(lastAskFor("/home/jc")?.showHidden).toBe(false));
  });

  it("says which state it is in", async () => {
    await opened();
    const before = screen.getByTestId("status-bar").textContent ?? "";

    press(".");

    await waitFor(() => expect(screen.getByTestId("status-bar").textContent).not.toBe(before));
  });
});

describe("the choice belongs to the window, not to one tab", () => {
  it("lists a tab opened afterwards in the same order", async () => {
    await opened();
    press(",", "s");
    await waitFor(() => expect(lastAskFor("/home/jc")?.sort).toBe("size"));

    // `t` opens a second tab on the current directory.
    press("t");

    await waitFor(() =>
      expect(log.listAsks.filter((a) => a.sort === "size").length).toBeGreaterThan(1),
    );
  });

  it("re-lists a background tab in the new order before it is shown", async () => {
    // The order changed while this tab was not visible. Switching to it must
    // show the new order rather than whatever it was left holding — otherwise
    // one window has two orders in it, which is the thing the operator chose
    // against.
    await opened();
    press("t");
    await act(async () => undefined);
    // Move the new tab somewhere else, so the two tabs are distinguishable.
    press("l");
    await act(async () => undefined);

    press(",", "s");
    await waitFor(() => expect(log.listAsks.some((a) => a.sort === "size")).toBe(true));

    // Back to the first tab.
    press("[");

    await waitFor(() => {
      const ask = lastAskFor("/home/jc");
      expect(ask?.sort).toBe("size");
    });
  });
});

describe("a listing still in flight when the order changes", () => {
  it("does not let the older answer land", async () => {
    // Every other listing in this fixture resolves in the same tick, so no test
    // here has ever had two loads overlapping — which is the only window in
    // which a stale reply can arrive. Review traced the guard (a generation
    // counter, and `listedUnder` written before the await) as sound and noted
    // that nothing exercised it; a later edit moving either of those after the
    // await would reintroduce the race in silence.
    //
    // `STALE-ONLY.txt` exists in no fixture directory. It can only reach the
    // column by way of the held reply, so its absence is the assertion.
    await opened();
    // Named for the CURRENT column. A change of options re-lists the parent
    // column too, and its effect runs first — an unnamed hold took that one
    // instead, left this column loading normally, and passed with the guard
    // removed. Measured, not reasoned about.
    const release = log.holdNextList("/home/jc", ["STALE-ONLY.txt"]);

    // Something that re-lists: the order changes, and the load is captured.
    press(",", "s");
    await act(async () => undefined);

    // A second change, whose listing is not held and answers immediately.
    press(",", "a");
    await waitFor(() => expect(lastAskFor("/home/jc")?.sort).toBe("alphabetical"));

    release();
    await act(async () => undefined);

    expect(namesIn("column-current")).not.toContain("STALE-ONLY.txt");
  });
});

/**
 * The order the window starts in, and the order it remembers.
 *
 * Two facts, and they are separate: what a FIRST run gets, and what a window
 * gets after the operator has chosen something. The store itself is covered in
 * `fm-main`; what is left here is that the window asks for what was stored and
 * writes back what was chosen.
 */
describe("the order the window opens in", () => {
  it("asks for modified, newest first, when nothing has been stored", async () => {
    // The operator's words: "I would like to leave the default to be modified
    // in descending order. That is what I want to have in all places."
    await opened();

    const ask = lastAskFor("/home/jc");
    expect(ask?.sort).toBe("modified");
    expect(ask?.reverse).toBe(true);
  });

  it("shows that default in the status bar", async () => {
    await opened();

    expect(screen.getByTestId("status-bar").textContent).toContain("sort: modified ↓");
  });

  it("asks for the order that was stored, not the default", async () => {
    log = installBridge({
      storedListing: { sort: "size", reverse: false, showHidden: true, renderDocuments: true },
    });
    await opened();

    await waitFor(() => {
      const ask = lastAskFor("/home/jc");
      expect(ask?.sort).toBe("size");
      expect(ask?.reverse).toBe(false);
      expect(ask?.showHidden).toBe(true);
    });
    expect(screen.getByTestId("status-bar").textContent).toContain("sort: size ↑");
  });

  it("does not list a second time when the stored order IS the default", async () => {
    // The window paints on the default and applies what was stored when it
    // arrives. Re-listing regardless would make a matching order flicker on
    // every open, which is the common case.
    log = installBridge({
      storedListing: { sort: "modified", reverse: true, showHidden: false, renderDocuments: true },
    });
    await opened();
    await act(async () => undefined);

    expect(log.listAsks.filter((ask) => ask.path === "/home/jc")).toHaveLength(1);
  });

  it("opens on the default when the store cannot be read, and says nothing", async () => {
    // A missing preference is not a failure. A window that refused to list, or
    // showed an error, would be worse than one that opens in an order the
    // operator has to set again.
    log = installBridge({ listingReadFails: true });
    await opened();

    const ask = lastAskFor("/home/jc");
    expect(ask?.sort).toBe("modified");
    expect(screen.queryByTestId("pane-error")).toBeNull();
  });
});

describe("the order the window remembers", () => {
  it("writes the whole object back when the sort changes", async () => {
    await opened();

    press(",", "s");

    await waitFor(() => expect(log.listingWrites.length).toBeGreaterThan(0));
    const written = log.listingWrites[log.listingWrites.length - 1];
    expect(written).toEqual({
      sort: "size",
      reverse: false,
      showHidden: false,
      renderDocuments: true,
    });
  });

  it("writes it back when the direction is reversed", async () => {
    await opened();

    press(",");
    pressShift("S");

    await waitFor(() => expect(log.listingWrites.length).toBeGreaterThan(0));
    expect(log.listingWrites[log.listingWrites.length - 1]?.reverse).toBe(true);
  });

  it("writes it back when hidden files are toggled", async () => {
    await opened();

    press(".");

    await waitFor(() => expect(log.listingWrites.length).toBeGreaterThan(0));
    expect(log.listingWrites[log.listingWrites.length - 1]?.showHidden).toBe(true);
  });

  it("does not write during the load itself", async () => {
    // A window that starts, loads, and saves the same values back is harmless
    // until two do it at once — and the file dialog opens a second one.
    log = installBridge({
      storedListing: { sort: "extension", reverse: true, showHidden: false, renderDocuments: true },
    });
    await opened();
    await act(async () => undefined);

    expect(log.listingWrites).toHaveLength(0);
  });
});

/**
 * Two things that were wrong once.
 *
 * The first came from this phase's review; the second cost an implement lap
 * and is the reason three tests above exist at all.
 */
describe("the order the window remembers, under pressure", () => {
  it("stores the LAST choice when two writes are in flight at once", async () => {
    // A real disk does not answer in the order it was asked. Two writes fired
    // independently are decided by whichever finishes last, so the earlier
    // choice can land on top of the later one — a change the status bar has
    // already shown as taken, absent on the next start. `useBookmarks` solves
    // this one file over and this hook had copied its shape without its chain.
    log = installBridge({ slowFirstListingWrite: true });
    await opened();

    press(",", "s");
    press(".");

    await waitFor(() => expect(log.listingWrites).toHaveLength(2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    expect(log.storedListingNow()).toEqual({
      sort: "size",
      reverse: false,
      showHidden: true,
      renderDocuments: true,
    });
  });

  it("still saves when React runs the load effect twice", async () => {
    // What this pins is that a DOUBLE-INVOKED effect does not leave the window
    // unable to save — not the ordering inside it. An earlier version of this
    // test claimed the latter and could not fail: unmounting and rendering
    // again gives a fresh ref, and even under `StrictMode` the second effect
    // issues its own read and sets the flag. The property below is real and
    // the one about ordering was not; see `useListingOptions.ts`.
    log = installBridge({
      storedListing: { sort: "size", reverse: false, showHidden: false, renderDocuments: true },
    });
    // `StrictMode` is the point of this test, not decoration: it makes React
    // run the effect, tear it down, and run it again on the SAME hook instance,
    // which is the only way a promise resolves into an already-cancelled
    // closure. Unmounting and rendering again gives a FRESH ref and cannot
    // reproduce it — the first version of this test did that and passed
    // against every mutation.
    render(
      <StrictMode>
        <App startPath="/home/jc" />
      </StrictMode>,
    );
    await waitFor(() => expect(namesIn("column-current").length).toBeGreaterThan(0));
    await act(async () => undefined);

    press(".");

    await waitFor(() => expect(log.listingWrites.length).toBeGreaterThan(0));
  });
});
