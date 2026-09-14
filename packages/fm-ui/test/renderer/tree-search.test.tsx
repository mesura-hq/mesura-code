/** @vitest-environment happy-dom */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { openTree, treeKey, treeRow } from "./tree-support.ts";

afterEach(cleanup);
async function search(query: string) {
  treeKey("/");
  const input = await screen.findByRole("textbox", { name: "Search loaded paths" });
  fireEvent.change(input, { target: { value: query } });
  return input;
}
it("searches unique loaded paths through collapsed branches without reading more scope", async () => {
  const log = await openTree();
  fireEvent.click(treeRow("/home/jc/src"));
  treeKey("h");
  const reads = log.overview.mock.calls.length;
  await search("SRC/BETA");
  await waitFor(() =>
    expect(treeRow("/home/jc/src/beta.ts").getAttribute("aria-selected")).toBe("true"),
  );
  expect(screen.getByRole("status", { name: "Search results" }).textContent).toContain(
    "1 / 1 · loaded paths",
  );
  expect(log.overview).toHaveBeenCalledTimes(reads);
});
it("confirms and wraps n/N through loaded matches without activating them", async () => {
  const log = await openTree();
  const input = await search("src/");
  await waitFor(() =>
    expect(screen.getByRole("status", { name: "Search results" }).textContent).toContain("1 / 3"),
  );
  fireEvent.keyDown(input, { key: "Enter" });
  treeKey("n");
  expect(treeRow("/home/jc/src/nested").getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(window, { key: "N", shiftKey: true });
  expect(treeRow("/home/jc/src/beta.ts").getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(window, { key: "N", shiftKey: true });
  expect(
    treeRow("/home/jc/src/nested/İinteresting long filename.md").getAttribute("aria-selected"),
  ).toBe("true");
  expect(log.open).not.toHaveBeenCalled();
});
it("clears temporary ancestors and cancels editing back to the captured cursor", async () => {
  await openTree();
  fireEvent.click(treeRow("/home/jc/src"));
  treeKey("h");
  let input = await search("beta.ts");
  await waitFor(() => treeRow("/home/jc/src/beta.ts"));
  fireEvent.keyDown(input, { key: "Escape" });
  expect(treeRow("/home/jc/src").getAttribute("aria-expanded")).toBe("false");
  expect(treeRow("/home/jc/src").getAttribute("aria-selected")).toBe("true");
  input = await search("beta.ts");
  await waitFor(() => treeRow("/home/jc/src/beta.ts"));
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(treeRow("/home/jc/src").getAttribute("aria-expanded")).toBe("false");
  expect(treeRow("/home/jc/src").getAttribute("aria-selected")).toBe("true");
});
it("returns keyboard ownership to Miller and overview after tree search", async () => {
  await openTree();
  const input = await search("beta");
  fireEvent.keyDown(input, { key: "Enter" });
  treeKey("Escape");
  expect(screen.queryByRole("status", { name: "Search results" })).toBeNull();
  fireEvent.keyDown(window, { key: "o", ctrlKey: true });
  await screen.findByRole("dialog", { name: "Folder overview" });
  await search("beta");
  expect(screen.getByRole("textbox", { name: "Search loaded paths" })).toBeTruthy();
});

it("retains a manual collapse of an ancestor that search expanded temporarily", async () => {
  await openTree();
  fireEvent.click(treeRow("/home/jc/src"));
  treeKey("h");
  const input = await search("beta.ts");
  await waitFor(() => treeRow("/home/jc/src/beta.ts"));
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.click(screen.getByRole("button", { name: "Collapse src" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(treeRow("/home/jc/src").getAttribute("aria-expanded")).toBe("false");
  treeKey("l");
  expect(treeRow("/home/jc/src/nested").getAttribute("aria-expanded")).toBe("true");
});
it("keeps excluded and hidden children outside search without reading them", async () => {
  const log = await openTree();
  const input = await search("node_modules/secret");
  expect(screen.getByRole("status", { name: "Search results" }).textContent).toContain("0 / 0");
  expect(log.overview.mock.calls.some(([request]) => request.path.endsWith("node_modules"))).toBe(
    false,
  );
  fireEvent.change(input, { target: { value: "   " } });
  expect(screen.getByRole("status", { name: "Search results" }).textContent).toContain("0 / 0");
});
it("clears transient search when switching tabs while preserving custom expansion", async () => {
  await openTree();
  fireEvent.click(treeRow("/home/jc/src"));
  treeKey("h");
  const input = await search("beta.ts");
  await waitFor(() => treeRow("/home/jc/src/beta.ts"));
  fireEvent.keyDown(input, { key: "Enter" });
  treeKey("t");
  treeKey("[");
  await screen.findByRole("tree");
  expect(screen.queryByRole("status", { name: "Search results" })).toBeNull();
  expect(treeRow("/home/jc/src").getAttribute("aria-expanded")).toBe("false");
});
