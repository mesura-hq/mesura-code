/** @vitest-environment happy-dom */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { openTree, treeEntry, treeKey, treeRow } from "./tree-support.ts";

afterEach(cleanup);
const shift = (key: string) => fireEvent.keyDown(window, { key, shiftKey: true });
const control = (key: string) => treeKey(key, true);

it("restores expansion, cursor and scroll separately for tab and hidden scope", async () => {
  await openTree(Array.from({ length: 100 }, (_, i) => treeEntry(`z${i}.txt`)));
  fireEvent.click(treeRow("/home/jc/src"));
  treeKey("h");
  let tree = screen.getByRole("tree");
  tree.scrollTop = 480;
  tree.scrollLeft = 30;
  fireEvent.scroll(tree);
  shift("H");
  await waitFor(() => expect(treeRow("/home/jc/src").getAttribute("aria-expanded")).toBe("true"));
  shift("H");
  await waitFor(() => expect(treeRow("/home/jc/src").getAttribute("aria-expanded")).toBe("false"));
  tree = screen.getByRole("tree");
  expect(tree.scrollTop).toBe(480);
  treeKey("t");
  expect(screen.queryByRole("tree")).toBeNull();
  control("Tab");
  await screen.findByRole("tree");
  expect(treeRow("/home/jc/src").getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByRole("tree").scrollTop).toBe(480);
});

it("preserves one custom expansion checkpoint across bulk presets and manual edits", async () => {
  await openTree();
  fireEvent.click(treeRow("/home/jc/src"));
  treeKey("h");
  fireEvent.click(screen.getByRole("button", { name: "Expand project" }));
  expect(treeRow("/home/jc/src").getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
  expect(treeRow("/home/jc").getAttribute("aria-expanded")).toBe("true");
  expect(treeRow("/home/jc/src").getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Restore my expansion" }));
  expect(treeRow("/home/jc/src").getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(treeRow("/home/jc/src"));
  treeKey("l");
  fireEvent.click(treeRow("/home/jc/src/nested"));
  treeKey("h");
  fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
  fireEvent.click(screen.getByRole("button", { name: "Restore my expansion" }));
  expect(treeRow("/home/jc/src").getAttribute("aria-expanded")).toBe("true");
  expect(treeRow("/home/jc/src/nested").getAttribute("aria-expanded")).toBe("false");
});

it("anchors a surviving path across an insertion and retains a manually collapsed branch", async () => {
  const log = await openTree(
    Array.from({ length: 100 }, (_, i) => treeEntry(`z${String(i).padStart(3, "0")}.txt`)),
  );
  fireEvent.click(treeRow("/home/jc/src"));
  treeKey("h");
  const tree = screen.getByRole("tree");
  tree.scrollTop = 480 + 7;
  fireEvent.scroll(tree);
  const watch = log.watched.find((id) => id.startsWith("overview:") && id.endsWith(":/home/jc"));
  if (!watch) throw new Error("Missing root watch");
  log.entries.set("/home/jc", [treeEntry("aaa.txt"), ...(log.entries.get("/home/jc") ?? [])]);
  act(() => log.emitChange(watch));
  await waitFor(() => expect(tree.scrollTop).toBe(511));
  expect(treeRow("/home/jc/src").getAttribute("aria-expanded")).toBe("false");
  expect(log.open).not.toHaveBeenCalled();
});

it("restores Miller on Escape and retains the tree cursor on reentry", async () => {
  await openTree();
  fireEvent.click(treeRow("/home/jc/src/beta.ts"));
  treeKey("Escape");
  expect(screen.queryByRole("tree")).toBeNull();
  expect(screen.getByTestId("path-bar").textContent).not.toContain("src");
  control("e");
  const tree = await screen.findByRole("tree");
  expect(tree.dataset.root).toBe("/home/jc");
  await waitFor(() =>
    expect(treeRow("/home/jc/src/beta.ts").getAttribute("aria-selected")).toBe("true"),
  );
  treeKey("Escape");
  treeKey("h");
  control("e");
  expect((await screen.findByRole("tree")).dataset.root).toBe("/home");
});

it("returns from tree-origin overview and reveals into tree without host activation", async () => {
  const log = await openTree();
  fireEvent.click(treeRow("/home/jc/src"));
  treeKey("h");
  control("o");
  const overview = await screen.findByRole("dialog", { name: "Folder overview" });
  expect(overview.dataset.root).toBe("/home/jc");
  treeKey("Escape");
  expect(treeRow("/home/jc/src").getAttribute("aria-expanded")).toBe("false");
  control("o");
  await screen.findByRole("dialog", { name: "Folder overview" });
  const file = document.querySelector<HTMLElement>('[data-entry="/home/jc/src/beta.ts"]');
  if (!file) throw new Error("Missing overview file target");
  fireEvent.click(file);
  treeKey("Enter");
  await waitFor(() =>
    expect(treeRow("/home/jc/src/beta.ts").getAttribute("aria-selected")).toBe("true"),
  );
  expect(log.open).not.toHaveBeenCalled();
});

it("cancels transients on tab changes and lets external open select the correct Miller tab", async () => {
  const log = await openTree();
  fireEvent.click(treeRow("/home/jc/src"));
  treeKey("h");
  treeKey("g");
  act(() => log.emitOpenPath("/home/jc/empty"));
  await waitFor(() => expect(screen.queryByRole("tree")).toBeNull());
  expect(screen.queryByTestId("which-key")).toBeNull();
  control("Tab");
  await screen.findByRole("tree");
  expect(treeRow("/home/jc/src").getAttribute("aria-expanded")).toBe("false");
});
