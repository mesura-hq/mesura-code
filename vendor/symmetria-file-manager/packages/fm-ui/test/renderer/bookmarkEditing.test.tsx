/**
 * @vitest-environment happy-dom
 *
 * Binding and unbinding a bookmark from the keyboard.
 *
 * The sub-mode itself was ported in the previous cycle and has been routed all
 * along — `gn` and `gx` reach `assignBookmark` and `deleteBookmark`, and the
 * cascade gives the sub-mode its own step ahead of chord resolution. What was
 * missing was anything for them to do.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../../src/App.tsx";
import { type BridgeLog, installBridge, namesIn } from "./support.ts";

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

/** The letters the last write persisted, in order. */
function lastWrite(): string | undefined {
  return [...log.ops].reverse().find((op) => op.startsWith("bookmarks "));
}

describe("binding a letter with gn", () => {
  it("binds the directory the tab is in", async () => {
    await opened("/home/jc/projects");

    press("g", "n", "w");

    // The seed's eight letters plus `w`.
    await waitFor(() => expect(lastWrite()).toBe("bookmarks cdhmoprvw"));
  });

  it("makes the new letter jump straight away, without a restart", async () => {
    await opened("/home/jc/projects");
    press("g", "n", "w");
    await waitFor(() => expect(lastWrite()).toContain("w"));

    press("g", "h");
    await waitFor(() => expect(screen.getByTestId("crumb-current").textContent).toBe("jc"));

    press("g", "w");

    await waitFor(() => expect(screen.getByTestId("crumb-current").textContent).toBe("projects"));
  });

  it("overwrites a letter that is already bound, without asking", async () => {
    // Qt overwrites silently, and a confirmation inside a two-keystroke chord
    // would cost more than the accident it prevents — which is undone by
    // pressing `gn` again on the right directory.
    await opened("/home/jc/projects");

    press("g", "n", "d");

    await waitFor(() => expect(lastWrite()).toBe("bookmarks cdhmoprv"));
    press("g", "d");
    await waitFor(() => expect(screen.getByTestId("crumb-current").textContent).toBe("projects"));
  });
});

describe("unbinding a letter with gx", () => {
  it("removes it, and the letter stops jumping", async () => {
    await opened();

    press("g", "x", "d");

    await waitFor(() => expect(lastWrite()).toBe("bookmarks chmoprv"));

    press("g", "d");
    const message = await screen.findByTestId("pane-message");
    expect(message.textContent).toMatch(/no bookmark/i);
  });

  it("does nothing at all for a letter that was not bound", async () => {
    await opened();
    const before = [...log.ops];

    press("g", "x", "q");

    expect(log.ops).toEqual(before);
  });
});

describe("the reserved letters cannot be bound or unbound", () => {
  it("refuses to bind g, n or x, and says why", async () => {
    await opened("/home/jc/projects");
    const before = [...log.ops];

    press("g", "n", "g");

    const message = await screen.findByTestId("pane-message");
    expect(message.textContent).toMatch(/reserved/i);
    expect(log.ops).toEqual(before);
  });

  it("refuses to unbind one too", async () => {
    await opened();
    const before = [...log.ops];

    press("g", "x", "n");

    const message = await screen.findByTestId("pane-message");
    expect(message.textContent).toMatch(/reserved/i);
    expect(log.ops).toEqual(before);
  });
});

describe("leaving a sub-mode without using it", () => {
  it("changes nothing when Escape ends the create sub-mode", async () => {
    await opened("/home/jc/projects");
    const before = [...log.ops];

    press("g", "n");
    fireEvent.keyDown(window, { key: "Escape" });

    expect(log.ops).toEqual(before);
  });

  it("changes nothing when Escape ends the delete sub-mode", async () => {
    await opened();
    const before = [...log.ops];

    press("g", "x");
    fireEvent.keyDown(window, { key: "Escape" });

    expect(log.ops).toEqual(before);
  });

  it("returns the keyboard to normal afterwards", async () => {
    // The sub-mode consumes every key while it is up, so leaving it has to
    // actually leave it — otherwise the next `j` is eaten as a bookmark letter.
    await opened();
    press("g", "n");
    fireEvent.keyDown(window, { key: "Escape" });

    fireEvent.keyDown(window, { key: "j" });

    await waitFor(() =>
      expect(
        screen.getByTestId("column-current").querySelector('[data-cursor="true"]')?.textContent,
      ).toContain("notes.txt"),
    );
  });
});

describe("the overlays list what is bound", () => {
  it("shows every bookmark under the g prefix in the which-key overlay", async () => {
    await opened();

    fireEvent.keyDown(window, { key: "g" });

    const overlay = await screen.findByTestId("which-key");
    const rows = within(overlay)
      .getAllByTestId("which-key-row")
      .map((row) => row.textContent ?? "");

    // The prefix's own row plus the eight seeded letters.
    expect(rows.some((row) => row.startsWith("g"))).toBe(true);
    expect(rows.some((row) => row.includes("Downloads"))).toBe(true);
    expect(rows.some((row) => row.includes("Pictures"))).toBe(true);
  });

  it("drops a letter from the overlay once it is unbound", async () => {
    await opened();
    press("g", "x", "d");
    await waitFor(() => expect(lastWrite()).toBe("bookmarks chmoprv"));

    fireEvent.keyDown(window, { key: "g" });

    const overlay = await screen.findByTestId("which-key");
    const rows = within(overlay)
      .getAllByTestId("which-key-row")
      .map((row) => row.textContent ?? "");
    expect(rows.some((row) => row.includes("Downloads"))).toBe(false);
    expect(rows.some((row) => row.includes("Pictures"))).toBe(true);
  });

  it("shows the same bookmarks in the help sheet", async () => {
    await opened();

    fireEvent.keyDown(window, { key: "?", shiftKey: true });

    const group = await screen.findByTestId("chord-group-g");
    expect(group.textContent).toContain("Downloads");
    expect(group.textContent).toContain("Videos");
  });
});

describe("two changes in quick succession", () => {
  it("reaches the disk in the order they were made", async () => {
    // Every write sends the WHOLE map, and the main process has no notion of
    // which one is newer — so two writes in flight at once are decided by
    // whichever finishes its disk I/O last. Losing that race means a change the
    // interface already showed as saved is quietly absent on the next start.
    //
    // The fixture holds the FIRST write open. Without serialisation the second
    // would sail past it and land first; with it, the second cannot start until
    // the first has finished.
    await opened("/home/jc/projects");
    const release = log.holdNextBookmarkWrite();

    press("g", "n", "w");
    await waitFor(() => expect(log.ops.filter((o) => o.startsWith("bookmarks "))).toHaveLength(1));

    press("g", "x", "d");
    // The second write must NOT have completed while the first is still held.
    await act(async () => undefined);
    expect(log.bookmarkWrites).toEqual([]);

    release();

    await waitFor(() => expect(log.bookmarkWrites).toHaveLength(2));
    // First the bind, then the removal — the order they were pressed in.
    expect(log.bookmarkWrites[0]).toBe("cdhmoprvw");
    expect(log.bookmarkWrites[1]).toBe("chmoprvw");
  });
});
