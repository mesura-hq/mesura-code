/**
 * @vitest-environment happy-dom
 *
 * Tabs, driven through the keyboard and the bar.
 *
 * The isolation claim is the one worth testing: a tab must keep its own
 * location, cursor and selection while another tab moves. A test that only
 * checked the active tab would pass for an implementation that shared one pane
 * between all of them.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../src/App.tsx";
import { type BridgeLog, cursorIn, installBridge, namesIn } from "./support.ts";

let log: BridgeLog;

beforeEach(() => {
  log = installBridge();
});
afterEach(cleanup);

async function opened(): Promise<void> {
  render(<App startPath="/home/jc" />);
  await waitFor(() => expect(namesIn("column-current")).toContain("projects"));
}

function tabNames(): string[] {
  return screen
    .queryAllByTestId("tab")
    .map((tab) => tab.querySelector(".tab__name")?.textContent ?? "");
}

describe("the tab bar", () => {
  it("stays hidden while there is only one tab", async () => {
    await opened();
    expect(screen.queryByTestId("tab-bar")).toBeNull();
  });

  it("appears with a second tab, naming each by its directory", async () => {
    await opened();

    fireEvent.keyDown(window, { key: "t" });

    await screen.findByTestId("tab-bar");
    expect(tabNames()).toEqual(["jc", "jc"]);
  });

  it("marks exactly one tab as the active one", async () => {
    await opened();
    fireEvent.keyDown(window, { key: "t" });
    await screen.findByTestId("tab-bar");

    const active = screen.getAllByTestId("tab").filter((t) => t.dataset["active"] === "true");
    expect(active).toHaveLength(1);
  });
});

describe("tab isolation", () => {
  it("leaves the first tab's cursor alone while the second one moves", async () => {
    // The claim that makes tabs worth having. An implementation sharing one
    // pane passes every single-tab test and fails this one.
    await opened();
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(cursorIn("column-current")).toContain("notes.txt"));

    fireEvent.keyDown(window, { key: "t" });
    await screen.findByTestId("tab-bar");
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(cursorIn("column-current")).toContain("todo.txt"));

    fireEvent.keyDown(window, { key: "[" });

    await waitFor(() => expect(cursorIn("column-current")).toContain("notes.txt"));
  });

  it("restores the location of the tab being entered", async () => {
    await opened();
    fireEvent.keyDown(window, { key: "t" });
    await screen.findByTestId("tab-bar");

    fireEvent.keyDown(window, { key: "l" });
    await waitFor(() => expect(namesIn("column-current")).toContain("beta.md"));
    expect(tabNames()).toEqual(["jc", "projects"]);

    fireEvent.keyDown(window, { key: "[" });
    await waitFor(() => expect(namesIn("column-current")).toContain("notes.txt"));

    fireEvent.keyDown(window, { key: "]" });
    await waitFor(() => expect(namesIn("column-current")).toContain("beta.md"));
  });

  it("keeps each tab's selection to itself", async () => {
    await opened();
    fireEvent.keyDown(window, { key: " " });
    await waitFor(() =>
      expect(screen.getByTestId("status-bar").textContent).toContain("1 selected"),
    );

    fireEvent.keyDown(window, { key: "t" });
    await screen.findByTestId("tab-bar");

    await waitFor(() =>
      expect(screen.getByTestId("status-bar").textContent).not.toMatch(/selected/i),
    );
  });
});

describe("cycling and activating", () => {
  it("wraps in both directions, unlike the cursor", async () => {
    await opened();
    fireEvent.keyDown(window, { key: "t" });
    await screen.findByTestId("tab-bar");

    // Two tabs: forward from the second wraps to the first.
    fireEvent.keyDown(window, { key: "]" });
    await waitFor(() => expect(screen.getAllByTestId("tab")[0]?.dataset["active"]).toBe("true"));

    fireEvent.keyDown(window, { key: "[" });
    await waitFor(() => expect(screen.getAllByTestId("tab")[1]?.dataset["active"]).toBe("true"));
  });

  it("activates a tab from the bar", async () => {
    await opened();
    fireEvent.keyDown(window, { key: "t" });
    await screen.findByTestId("tab-bar");

    const first = screen.getAllByTestId("tab")[0];
    fireEvent.click(within(first as HTMLElement).getByText("jc"));

    await waitFor(() => expect(screen.getAllByTestId("tab")[0]?.dataset["active"]).toBe("true"));
  });
});

describe("closing", () => {
  it("puts the window away rather than leaving an empty shell", async () => {
    // There is no such thing as a window with no tabs, so closing the last one
    // dismisses the file manager.
    //
    // It used to call `window.close()`, and this test used to assert exactly
    // that. Verification found what it cost: page code closing an Electron
    // window DESTROYS it, and — measured on Electron 41 — never raises the
    // window's own `close` event, so the main process cannot intercept it. The
    // tab set, the cursor and the scroll position went with it, and the daemon
    // then answered every `open` with success having nowhere to open anything.
    //
    // So the assertion is now on the bridge call, which is the route that
    // hides. Asserting `window.close()` again would be re-asserting the defect.
    const log = installBridge();
    await opened();

    fireEvent.keyDown(window, { key: "q", ctrlKey: true });

    await waitFor(() => expect(log.hidden).toHaveLength(1));
  });

  it("keeps the window when another tab remains", async () => {
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    await opened();
    fireEvent.keyDown(window, { key: "t" });
    await screen.findByTestId("tab-bar");

    fireEvent.keyDown(window, { key: "q", ctrlKey: true });

    await waitFor(() => expect(screen.queryByTestId("tab-bar")).toBeNull());
    expect(close).not.toHaveBeenCalled();
    close.mockRestore();
  });

  it("releases the watch a closed tab held", async () => {
    // An inotify budget exhausted by abandoned watches is a defect that only
    // shows up after an hour of use, which is why it is pinned here.
    await opened();
    fireEvent.keyDown(window, { key: "t" });
    await screen.findByTestId("tab-bar");
    fireEvent.keyDown(window, { key: "l" });
    await waitFor(() => expect(namesIn("column-current")).toContain("beta.md"));

    fireEvent.keyDown(window, { key: "q", ctrlKey: true });

    await waitFor(() => expect(log.unwatched).toContain("tab-1:/home/jc/projects"));
  });

  it("watches a background tab's own directory, not only the visible one", async () => {
    // Switching to a tab must show what is there NOW. Without its own watch a
    // background tab would show whatever was there when it was last looked at.
    await opened();
    fireEvent.keyDown(window, { key: "t" });
    await screen.findByTestId("tab-bar");
    fireEvent.keyDown(window, { key: "l" });
    await waitFor(() => expect(namesIn("column-current")).toContain("beta.md"));

    // Both directories were listed: the background tab's and the active one's.
    expect(log.listed).toContain("/home/jc");
    expect(log.listed).toContain("/home/jc/projects");
  });
});

describe("change events reach the tab they belong to, and only that one", () => {
  it("attaches ONE listener however many tabs are open", async () => {
    // A listener per watch made every filesystem event wake every tab —
    // O(tabs) re-listings per event — and eleven tabs was enough for Electron
    // to print `MaxListenersExceededWarning`.
    await opened();
    for (let i = 0; i < 5; i++) fireEvent.keyDown(window, { key: "t" });
    await waitFor(() => expect(screen.getAllByTestId("tab")).toHaveLength(6));

    expect(log.listenerCount()).toBe(1);
  });

  it("re-lists only the tab whose directory changed", async () => {
    await opened();
    fireEvent.keyDown(window, { key: "t" });
    await screen.findByTestId("tab-bar");
    fireEvent.keyDown(window, { key: "l" });
    await waitFor(() => expect(namesIn("column-current")).toContain("beta.md"));
    await waitFor(() => expect(log.watched).toContain("tab-1:/home/jc/projects"));

    const before = log.listed.length;
    log.emitChange("tab-1:/home/jc/projects");

    // Exactly one new listing, for the directory that changed. A broadcast
    // would re-list every open tab.
    await waitFor(() => expect(log.listed.length).toBe(before + 1));
    expect(log.listed.at(-1)).toBe("/home/jc/projects");
  });

  it("ignores a change for a subscription nobody holds", async () => {
    await opened();
    const before = log.listed.length;

    log.emitChange("tab-99:/somewhere/else");

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(log.listed.length).toBe(before);
  });

  it("shows a background tab's new file when its own watch fires", async () => {
    await opened();
    fireEvent.keyDown(window, { key: "t" });
    await screen.findByTestId("tab-bar");
    fireEvent.keyDown(window, { key: "l" });
    await waitFor(() => expect(namesIn("column-current")).toContain("beta.md"));

    // The background tab's directory gains a file while another tab is visible.
    log.addEntry("/home/jc", "arrived.txt");
    log.emitChange("tab-0:/home/jc");

    fireEvent.keyDown(window, { key: "[" });
    await waitFor(() => expect(namesIn("column-current")).toContain("arrived.txt"));
  });
});
