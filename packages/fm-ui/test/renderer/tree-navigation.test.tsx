/** @vitest-environment happy-dom */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { openTree, treeEntry, treeKey, treeRow } from "./tree-support.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function selected() {
  return screen.getByRole("tree").querySelector<HTMLElement>('[aria-selected="true"]');
}

it("supports the complete structural keyboard table without leaving the root", async () => {
  const log = await openTree([treeEntry(".hidden")]);
  fireEvent.click(treeRow("/home/jc/notes.txt"));
  treeKey("Home");
  expect(selected()?.dataset.path).toBe("/home/jc");
  treeKey("End");
  expect(selected()?.dataset.path).toBe("/home/jc/notes.txt");
  treeKey("g");
  treeKey("g");
  expect(selected()?.dataset.path).toBe("/home/jc");
  fireEvent.click(treeRow("/home/jc/src"));
  treeKey("o");
  expect(treeRow("/home/jc/src").getAttribute("aria-expanded")).toBe("false");
  treeKey("l");
  treeKey("l");
  expect(selected()?.dataset.path).toBe("/home/jc/src/nested");
  treeKey("h");
  treeKey("h");
  expect(selected()?.dataset.path).toBe("/home/jc/src");
  expect(fireEvent.keyDown(screen.getByRole("tree"), { key: "Tab" })).toBe(true);
  treeKey("Escape");
  expect(screen.queryByRole("tree")).toBeNull();
  treeKey("e", true);
  await screen.findByRole("tree");
  fireEvent.keyDown(window, { key: "H", shiftKey: true });
  await waitFor(() => expect(treeRow("/home/jc/.hidden")).toBeTruthy());
  const reads = log.overview.mock.calls.length;
  fireEvent.keyDown(window, { key: "R", shiftKey: true });
  await waitFor(() => expect(log.overview.mock.calls.length).toBeGreaterThan(reads));
  expect(log.open).not.toHaveBeenCalled();
});

it("accumulates repeated page targets from measured height and settles with a mounted cursor", async () => {
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }));
  await openTree(
    Array.from({ length: 300 }, (_, i) => treeEntry(`z${String(i).padStart(3, "0")}.txt`)),
  );
  const tree = screen.getByRole("tree");
  Object.defineProperty(tree, "clientHeight", { value: 240, configurable: true });
  treeKey("Home");
  for (let i = 0; i < 3; i++) treeKey("d", true);
  expect(selected()?.style.top).toBe("360px");
  expect(tree.scrollTop).toBe(360);
  treeKey("u", true);
  expect(selected()?.style.top).toBe("240px");
  treeKey("PageDown");
  expect(selected()?.style.top).toBe("480px");
  expect(tree.scrollTop).toBe(480);
  treeKey("PageUp");
  expect(selected()?.style.top).toBe("240px");
  expect(document.getElementById(tree.getAttribute("aria-activedescendant") ?? "")).not.toBeNull();
});
