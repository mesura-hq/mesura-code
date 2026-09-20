/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { App } from "../../src/App.tsx";
import { installTreeBridge, openTree, treeEntry, treeKey, treeRow } from "./tree-support.ts";

afterEach(cleanup);

it("opens the current directory with Ctrl+E without a Miller toolbar button", async () => {
  installTreeBridge();
  render(<App startPath="/home/jc" />);
  expect(screen.queryByRole("button", { name: "Show file tree" })).toBeNull();
  treeKey("e", true);
  expect((await screen.findByRole("tree")).dataset.root).toBe("/home/jc");
  treeKey("e", true);
  expect(screen.getByRole("tree")).toBeTruthy();
  treeKey("Escape");
  expect(screen.queryByRole("tree")).toBeNull();
  treeKey("e", true);
  expect((await screen.findByRole("tree")).dataset.root).toBe("/home/jc");
});

it("automatically discovers and expands ordinary descendants without branch visits", async () => {
  const log = await openTree();
  await waitFor(() =>
    expect(treeRow("/home/jc/src/nested/İinteresting long filename.md")).toBeTruthy(),
  );
  expect(treeRow("/home/jc/src").getAttribute("aria-expanded")).toBe("true");
  expect(log.overview.mock.calls.some(([request]) => request.path === "/home/jc/src/nested")).toBe(
    true,
  );
});

it("distinguishes loaded empty, excluded, partial and unreadable branches", async () => {
  await openTree();
  await waitFor(() =>
    expect(treeRow("/home/jc/locked").textContent).toContain("permission denied"),
  );
  expect(treeRow("/home/jc/node_modules").textContent).toContain("Excluded by scope");
  expect(treeRow("/home/jc/partial").textContent).toContain("directory limit reached");
  expect(treeRow("/home/jc/empty").dataset.coverage).toBe("Loaded");
  expect(treeRow("/home/jc/empty").getAttribute("aria-expanded")).toBe("true");
});

it("bounds mounted rows independently of the complete loaded row count", async () => {
  await openTree(Array.from({ length: 600 }, (_, i) => treeEntry(`z${i}.txt`)));
  const tree = screen.getByRole("tree");
  await waitFor(() => expect(Number(tree.dataset.rowCount)).toBeGreaterThan(600));
  expect(within(tree).getAllByRole("treeitem").length).toBeLessThanOrEqual(51);
});

it("keeps full basenames, icons and hierarchy metadata for nested entries", async () => {
  await openTree();
  const path = "/home/jc/src/nested/İinteresting long filename.md";
  await waitFor(() => expect(treeRow(path)).toBeTruthy());
  const row = treeRow(path);
  expect(row.textContent).toContain("İinteresting long filename.md");
  expect(row.querySelector("svg")).not.toBeNull();
  expect(row.getAttribute("aria-level")).toBe("4");
  expect(row.getAttribute("aria-posinset")).toBe("1");
  expect(row.getAttribute("aria-setsize")).toBe("1");
  expect(row.hasAttribute("aria-expanded")).toBe(false);
});

it("moves and toggles the tree cursor without retargeting its root", async () => {
  await openTree();
  fireEvent.click(treeRow("/home/jc/src"));
  treeKey("ArrowLeft");
  expect(treeRow("/home/jc/src").getAttribute("aria-expanded")).toBe("false");
  treeKey("ArrowRight");
  expect(treeRow("/home/jc/src").getAttribute("aria-expanded")).toBe("true");
  treeKey("j");
  const tree = screen.getByRole("tree");
  expect(
    document.getElementById(tree.getAttribute("aria-activedescendant") ?? "")?.dataset.path,
  ).toBe("/home/jc/src/nested");
  treeKey("k");
  expect(tree.dataset.root).toBe("/home/jc");
});

it("activates the exact selected file once for Enter and once for double click", async () => {
  const log = await openTree();
  fireEvent.click(treeRow("/home/jc/src/beta.ts"));
  treeKey("Enter");
  await waitFor(() => expect(log.open).toHaveBeenCalledTimes(1));
  expect(log.open).toHaveBeenLastCalledWith({ path: "/home/jc/src/beta.ts" });
  fireEvent.doubleClick(treeRow("/home/jc/notes.txt"));
  await waitFor(() => expect(log.open).toHaveBeenCalledTimes(2));
  expect(log.open).toHaveBeenLastCalledWith({ path: "/home/jc/notes.txt" });
});

it("blocks unsupported tree actions and keeps picker windows in Miller", async () => {
  const log = await openTree();
  fireEvent.click(treeRow("/home/jc/src/beta.ts"));
  for (const key of ["d", "r", "y", "x", "p", " "]) treeKey(key);
  expect(log.trash).not.toHaveBeenCalled();
  expect(log.clipboard).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  cleanup();
  render(
    <App
      startPath="/home/jc"
      picker={{
        fifo: "/tmp/tree-picker",
        options: {
          title: "Choose",
          acceptLabel: "",
          directory: false,
          multiple: false,
          saveMode: false,
          suggestedName: "",
          currentFolder: "",
        },
      }}
    />,
  );
  treeKey("e", true);
  expect(screen.queryByRole("tree")).toBeNull();
  expect(screen.queryByRole("button", { name: "Show file tree" })).toBeNull();
});

it("uses a shallower tree snapshot and preserves it across a deeper overview visit", async () => {
  const log = installTreeBridge();
  let path = "/home/jc";
  for (let depth = 0; depth < 10; depth++) {
    log.entries.set(path, [treeEntry("nested", "directory")]);
    path += "/nested";
  }
  render(<App startPath="/home/jc" />);
  treeKey("e", true);
  const boundary = `/home/jc${"/nested".repeat(6)}`;
  await waitFor(() => expect(treeRow(boundary).textContent).toContain("Depth limit reached"));
  expect(log.overview.mock.calls.some(([request]) => request.path === boundary)).toBe(false);
  expect(document.querySelector(".file-tree .overview-popover")?.textContent).toContain("Depth 6");
  const treeRows = screen.getByRole("tree").dataset.rowCount;
  fireEvent.keyDown(window, { key: "o", ctrlKey: true });
  await screen.findByRole("dialog", { name: "Folder overview" });
  await waitFor(() =>
    expect(log.overview.mock.calls.some(([request]) => request.path === boundary)).toBe(true),
  );
  expect(document.querySelector('.file-tree [role="tree"]')?.getAttribute("data-row-count")).toBe(
    treeRows,
  );
  treeKey("Escape");
  await waitFor(() => expect(treeRow(boundary).textContent).toContain("Depth limit reached"));
  expect(screen.getByRole("tree").dataset.rowCount).toBe(treeRows);
  // An explicit branch read remains available at the shallower boundary.
  fireEvent.click(within(treeRow(boundary)).getByRole("button", { name: "Include nested" }));
  await waitFor(() =>
    expect(treeRow(`${boundary}/nested`).textContent).toContain("Depth limit reached"),
  );
});

it("reveals an overview file below the tree depth limit without activating it", async () => {
  const log = installTreeBridge();
  let path = "/home/jc";
  for (let depth = 0; depth < 7; depth++) {
    log.entries.set(path, [treeEntry("nested", "directory")]);
    path += "/nested";
  }
  log.entries.set(path, [treeEntry("deep.txt")]);
  const target = `${path}/deep.txt`;
  render(<App startPath="/home/jc" />);
  treeKey("e", true);
  await waitFor(() => expect(screen.getByRole("tree").dataset.rowCount).toBe("7"));
  treeKey("o", true);
  const overview = await screen.findByRole("dialog", { name: "Folder overview" });
  await waitFor(() => expect(within(overview).queryByText("Loading…")).toBeNull());
  treeKey("/");
  const input = within(overview).getByRole("textbox", { name: "Search loaded paths" });
  fireEvent.change(input, { target: { value: "deep.txt" } });
  fireEvent.keyDown(input, { key: "Enter" });
  treeKey("Enter");
  await waitFor(() => expect(treeRow(target).getAttribute("aria-selected")).toBe("true"));
  expect(log.open).not.toHaveBeenCalled();
});
