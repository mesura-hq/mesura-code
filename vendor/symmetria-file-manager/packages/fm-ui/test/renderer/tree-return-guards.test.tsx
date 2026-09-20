/** @vitest-environment happy-dom */

import type { OverviewFolder } from "@symmetria/fm-core/overview/model";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../../src/App.tsx";
import { FileTree } from "../../src/tree/FileTree.tsx";
import { TreeStateCache } from "../../src/tree/state.ts";
import { installTreeBridge, openTree, treeEntry, treeKey, treeRow } from "./tree-support.ts";

beforeEach(() => {
  // Happy DOM does not apply scrollTo offsets. Model the browser write so the
  // virtualizer's initial scroll cannot silently overwrite restored anchors.
  vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(function (
    this: HTMLElement,
    options: ScrollToOptions | number,
    y?: number,
  ) {
    if (typeof options === "number") {
      this.scrollLeft = options;
      this.scrollTop = y ?? 0;
    } else {
      this.scrollLeft = options.left ?? this.scrollLeft;
      this.scrollTop = options.top ?? this.scrollTop;
    }
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("keeps a collapsed selected folder and the custom checkpoint through Miller returns", async () => {
  await openTree();
  fireEvent.click(treeRow("/home/jc/src"));
  treeKey("h");
  treeKey("Escape");
  expect(screen.queryByRole("tree")).toBeNull();
  treeKey("e", true);
  await waitFor(() => expect(treeRow("/home/jc/src").getAttribute("aria-expanded")).toBe("false"));
  fireEvent.click(screen.getByRole("button", { name: "Expand project" }));
  treeKey("Escape");
  expect(screen.queryByRole("tree")).toBeNull();
  treeKey("e", true);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Restore my expansion" }).disabled,
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Restore my expansion" }));
  expect(treeRow("/home/jc/src").getAttribute("aria-expanded")).toBe("false");
});

it("brings an initial offscreen Miller selection into the tree viewport", async () => {
  installTreeBridge(
    Array.from({ length: 150 }, (_, i) => treeEntry(`z${String(i).padStart(3, "0")}.txt`)),
  );
  render(<App startPath="/home/jc" />);
  await waitFor(() =>
    expect(screen.getByTestId("status-bar").textContent).toContain("156 entries"),
  );
  fireEvent.keyDown(window, { key: "G", shiftKey: true });
  treeKey("e", true);
  const tree = await screen.findByRole("tree");
  await waitFor(() =>
    expect(treeRow("/home/jc/z149.txt").getAttribute("aria-selected")).toBe("true"),
  );
  expect(tree.scrollTop).toBeGreaterThan(2000);
});

it("closes without requesting a Miller reveal and restores the tree cursor", async () => {
  const log = await openTree();
  fireEvent.click(treeRow("/home/jc/notes.txt"));
  const reads = log.list.mock.calls.length;
  treeKey("Escape");
  expect(screen.queryByRole("tree")).toBeNull();
  expect(log.list).toHaveBeenCalledTimes(reads);
  treeKey("e", true);
  await waitFor(() =>
    expect(treeRow("/home/jc/notes.txt").getAttribute("aria-selected")).toBe("true"),
  );
});

it("cancels animated paging when Left selects an offscreen parent", async () => {
  await openTree(Array.from({ length: 150 }, (_, i) => treeEntry(`z${i}.txt`)));
  const tree = screen.getByRole("tree");
  Object.defineProperty(tree, "clientHeight", { value: 240, configurable: true });
  treeKey("Home");
  for (let i = 0; i < 5; i++) treeKey("d", true);
  treeKey("h");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  expect(treeRow("/home/jc").getAttribute("aria-selected")).toBe("true");
  expect(tree.scrollTop).toBe(0);
});

it("restores a tab anchor after the virtualizer initializes its native scroll", async () => {
  await openTree(Array.from({ length: 150 }, (_, i) => treeEntry(`z${i}.txt`)));
  treeKey("t");
  treeKey("e", true);
  await screen.findByRole("tree");
  treeKey("End");
  const before = screen.getByRole("tree").scrollTop;
  expect(before).toBeGreaterThan(2000);
  treeKey("[");
  treeKey("]");
  await waitFor(() => expect(screen.getByRole("tree").scrollTop).toBe(before));
});

it("finishes an initial reveal after discovery inserts rows above its target", () => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(240);
  const root = "/root";
  const record = new TreeStateCache().get("tab", root, false);
  record.shape.selected = "/root/z.txt";
  record.pendingReveal = "/root/z.txt";
  const folders = new Map<string, OverviewFolder>([
    [
      root,
      {
        path: root,
        depth: 0,
        status: "Loaded",
        entries: [treeEntry("a", "directory"), treeEntry("z.txt")],
      },
    ],
  ]);
  const props = {
    root,
    record,
    port: { connect: () => () => {}, select: () => {} },
    onOpen: () => {},
    onMiller: () => {},
  };
  const initial = { folders, loading: true, inspected: 2, include: () => {} };
  const { rerender } = render(<FileTree {...props} model={initial} />);
  const loaded = new Map(folders).set("/root/a", {
    path: "/root/a",
    depth: 1,
    status: "Loaded",
    entries: Array.from({ length: 25 }, (_, i) => treeEntry(`file-${i}`)),
  });
  rerender(<FileTree {...props} model={{ ...initial, folders: loaded, loading: false }} />);
  const tree = screen.getByRole("tree");
  const top = Number.parseFloat(treeRow("/root/z.txt").style.top);
  expect(top).toBeGreaterThan(240);
  expect(top).toBeGreaterThanOrEqual(tree.scrollTop);
  expect(top + 24).toBeLessThanOrEqual(tree.scrollTop + tree.clientHeight);
  expect(record.pendingReveal).toBeNull();
});

it("defers a cached anchor until its row returns after snapshot eviction", () => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(240);
  const root = "/root";
  const record = new TreeStateCache().get("tab", root, false);
  record.shape.selected = "/root/z149";
  record.anchor = { path: "/root/z140", offset: 0, left: 0 };
  record.restoreAnchor = true;
  const props = {
    root,
    record,
    port: { connect: () => () => {}, select: () => {} },
    onOpen: () => {},
    onMiller: () => {},
  };
  const initial = {
    folders: new Map<string, OverviewFolder>(),
    loading: true,
    inspected: 0,
    include: () => {},
  };
  const { rerender } = render(<FileTree {...props} model={initial} />);
  expect(record.anchor?.path).toBe("/root/z140");
  const folders = new Map<string, OverviewFolder>([
    [
      root,
      {
        path: root,
        depth: 0,
        status: "Loaded",
        entries: Array.from({ length: 150 }, (_, i) => treeEntry(`z${String(i).padStart(3, "0")}`)),
      },
    ],
  ]);
  rerender(<FileTree {...props} model={{ ...initial, folders, loading: false }} />);
  const tree = screen.getByRole("tree");
  expect(tree.scrollTop).toBe(141 * 24);
  expect(treeRow("/root/z149").getAttribute("aria-selected")).toBe("true");
});
