/**
 * @vitest-environment happy-dom
 *
 * The wiring, not the components.
 *
 * `columns.test.tsx` proves each component renders when something mounts it.
 * That is exactly the assurance that failed: every component was correct and
 * NOTHING mounted them, so the real window showed a placeholder while 76 tests
 * passed. These tests drive the composed `App` through the bridge and the
 * keyboard, so an orphaned component fails here.
 */

import { BRIDGE_KEY } from "@symmetria/fm-core/bridge";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../../src/App.tsx";
import {
  type BridgeLog,
  cursorIn,
  HOME_ENTRY_COUNT,
  HOME_LAST_ENTRY,
  installBridge,
  namesIn,
} from "./support.ts";

let log: BridgeLog;

beforeEach(() => {
  log = installBridge();
});

afterEach(cleanup);

describe("App, wired to a bridge", () => {
  it("lists the starting directory and its parent through the bridge", async () => {
    render(<App startPath="/home/jc" />);

    await waitFor(() => expect(namesIn("column-current")).toContain("notes.txt"));
    expect(namesIn("column-parent")).toContain("jc");
    expect(log.listed).toContain("/home/jc");
    expect(log.listed).toContain("/home");
  });

  it("draws each row's file-type icon", async () => {
    // The pane's own rows had NO icon assertion anywhere: deleting `<FileIcon>`
    // from `FileRow` left the whole panel suite green. The component now ships
    // from another package, so a broken import here would be silent too.
    render(<App startPath="/home/jc" />);
    await waitFor(() => expect(namesIn("column-current")).toContain("notes.txt"));

    const drawn = screen
      .getAllByTestId("row")
      .map((element) => element.querySelector("[data-icon]")?.getAttribute("data-icon"));
    expect(drawn).not.toContain(undefined);
    // A concrete token as well as "something drew", so a component that always
    // answered `default` could not pass.
    expect(drawn).toContain("text");
  });

  it("shows the location as breadcrumbs and the count in the status bar", async () => {
    render(<App startPath="/home/jc" />);

    await waitFor(() => expect(namesIn("column-current")).toContain("notes.txt"));
    expect(within(screen.getByTestId("path-bar")).getByText("jc")).toBeDefined();
    expect(screen.getByTestId("status-bar").textContent).toContain(`${HOME_ENTRY_COUNT} entries`);
  });

  it("moves the cursor down without wrapping past the last entry", async () => {
    render(<App startPath="/home/jc" />);
    await waitFor(() => expect(namesIn("column-current")).toContain("notes.txt"));

    for (let i = 0; i < 10; i++) fireEvent.keyDown(window, { key: "j" });

    await waitFor(() => expect(cursorIn("column-current")).toContain(HOME_LAST_ENTRY));
  });

  it("moves the cursor up without wrapping past the first entry", async () => {
    render(<App startPath="/home/jc" />);
    await waitFor(() => expect(namesIn("column-current")).toContain("notes.txt"));

    for (let i = 0; i < 10; i++) fireEvent.keyDown(window, { key: "k" });

    await waitFor(() => expect(cursorIn("column-current")).toContain("projects"));
  });

  it("enters a directory, promoting it to the current column", async () => {
    render(<App startPath="/home/jc" />);
    await waitFor(() => expect(namesIn("column-current")).toContain("projects"));

    fireEvent.keyDown(window, { key: "l" });

    await waitFor(() => expect(namesIn("column-current")).toContain("beta.md"));
    // The column that was current is now the parent, sitting on where we came
    // from. This is the criterion a component test cannot reach: it is about
    // two columns agreeing after a navigation.
    await waitFor(() => expect(cursorIn("column-parent")).toContain("projects"));
    expect(screen.getByTestId("path-bar").textContent).toContain("projects");
  });

  it("restores the cursor to the entry that was entered, on the way back out", async () => {
    render(<App startPath="/home/jc" />);
    await waitFor(() => expect(namesIn("column-current")).toContain("projects"));

    // Down to `todo.txt`, up to `projects`, in — so the remembered cursor is
    // not simply index zero, which would pass by accident.
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(cursorIn("column-current")).toContain("todo.txt"));

    fireEvent.keyDown(window, { key: "k" });
    fireEvent.keyDown(window, { key: "k" });
    fireEvent.keyDown(window, { key: "l" });
    await waitFor(() => expect(namesIn("column-current")).toContain("beta.md"));

    fireEvent.keyDown(window, { key: "h" });

    await waitFor(() => expect(cursorIn("column-current")).toContain("projects"));
  });

  it("stops at the root rather than climbing past it", async () => {
    render(<App startPath="/home" />);
    await waitFor(() => expect(namesIn("column-current")).toContain("jc"));

    for (let i = 0; i < 5; i++) fireEvent.keyDown(window, { key: "h" });

    // Five presses from `/home` is four more than there is anywhere to go.
    await waitFor(() => expect(namesIn("column-current")).toContain("home"));
    expect(screen.getByTestId("path-bar").textContent).toBe("/");
    // Arriving somewhere real, not stranded: the clamp is `leaveDirectory`
    // refusing to go above `/`, and it must not look like a failed listing.
    expect(screen.queryByTestId("pane-error")).toBeNull();
  });

  it("releases the watch on the directory it left", async () => {
    render(<App startPath="/home/jc" />);
    await waitFor(() => expect(namesIn("column-current")).toContain("projects"));

    fireEvent.keyDown(window, { key: "l" });
    await waitFor(() => expect(namesIn("column-current")).toContain("beta.md"));

    // A watch per navigation that is never released is how the inotify budget
    // disappears during ordinary use — the same failure that removed the
    // recursive watcher, arriving by a slower route.
    // The id names the tab AND the directory, so a tab that navigates releases
    // the watch it held rather than the one it now wants.
    await waitFor(() => expect(log.unwatched).toContain("tab-0:/home/jc"));
  });
});

describe("App, with no bridge", () => {
  it("says the build is incomplete instead of rendering an empty window", async () => {
    Reflect.deleteProperty(window, BRIDGE_KEY);

    render(<App startPath="/home/jc" />);

    await waitFor(() => expect(screen.getByTestId("pane-error").textContent).toMatch(/preload/i));
  });
});
