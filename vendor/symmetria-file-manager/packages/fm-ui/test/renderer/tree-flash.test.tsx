/** @vitest-environment happy-dom */
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockTextRanges } from "./flash-text-geometry.ts";
import { openTree, treeKey, treeRow } from "./tree-support.ts";

beforeEach(() => {
  mockTextRanges();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const inset = document.querySelector(".overview-search") ? 30 : 0;
    if (this.matches(".tree-viewport")) return new DOMRect(0, 40 + inset, 800, 568 - inset);
    const path = this.closest<HTMLElement>("[data-path]")?.dataset.path;
    if (path === "/home/jc/src/beta.ts") return new DOMRect(60, 160 + inset, 140, 24);
    if (path === "/home/jc/notes.txt") return new DOMRect(1000, 120, 140, 24);
    return new DOMRect();
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function flash() {
  treeKey("s");
  await screen.findByRole("status", { name: "Flash navigation" });
  treeKey("b");
  treeKey("e");
}
it("labels visible filenames and selects the exact path without opening it", async () => {
  const log = await openTree();
  await flash();
  const label = document.querySelector<HTMLElement>("[data-flash-label]");
  expect(label?.dataset.flashPath).toBe("/home/jc/src/beta.ts");
  for (const character of label?.dataset.flashLabel ?? "") treeKey(character);
  expect(treeRow("/home/jc/src/beta.ts").getAttribute("aria-selected")).toBe("true");
  expect(log.open).not.toHaveBeenCalled();
});
it("places native-size flash labels after bright query text without a query backdrop", async () => {
  await openTree();
  const name = treeRow("/home/jc/src/beta.ts").querySelector<HTMLElement>(".tree-name");
  if (name) name.style.fontSize = "14px";
  await flash();
  const label = document.querySelector<HTMLElement>("[data-flash-label]");
  expect(label).not.toBeNull();
  expect(label?.style.fontSize).toBe(name ? window.getComputedStyle(name).fontSize : "missing");
  expect(document.querySelector(".overview-flash-match")?.textContent).toBe("beta.ts");
  expect(document.querySelector('[data-flash-mode="true"]')).not.toBeNull();
});
it("cancels stale flash on scroll and ignores a held s after completion", async () => {
  await openTree();
  await flash();
  fireEvent.scroll(screen.getByRole("tree"));
  expect(screen.queryByRole("status", { name: "Flash navigation" })).toBeNull();
  fireEvent.keyDown(window, { key: "s", repeat: true });
  expect(screen.queryByRole("status", { name: "Flash navigation" })).toBeNull();
});

it("keeps captured geometry when flash follows a confirmed search", async () => {
  const log = await openTree();
  treeKey("/");
  const input = screen.getByRole("textbox", { name: "Search loaded paths" });
  fireEvent.change(input, { target: { value: "beta" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await flash();
  const label = document.querySelector<HTMLElement>("[data-flash-label]");
  expect(label?.dataset.flashPath).toBe("/home/jc/src/beta.ts");
  for (const key of label?.dataset.flashLabel ?? "") treeKey(key);
  expect(treeRow("/home/jc/src/beta.ts").getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("status", { name: "Search results" }).textContent).toContain("1 / 1");
  expect(log.open).not.toHaveBeenCalled();
});
it("focuses the tree when flash starts from a toolbar and after selection", async () => {
  const log = await openTree();
  screen.getByRole("button", { name: "Refresh" }).focus();
  await flash();
  expect(document.activeElement).toBe(screen.getByRole("tree"));
  const label = document.querySelector<HTMLElement>("[data-flash-label]")?.dataset.flashLabel;
  expect(label).toBeTruthy();
  for (const key of label ?? "") treeKey(key);
  expect(document.activeElement).toBe(screen.getByRole("tree"));
  expect(log.open).not.toHaveBeenCalled();
});
it("does not label horizontally clipped names and cancels on view shortcuts", async () => {
  await openTree();
  treeKey("s");
  treeKey("n");
  treeKey("o");
  expect(document.querySelectorAll("[data-flash-label]")).toHaveLength(0);
  treeKey("Escape");
  expect(screen.getByRole("tree")).toBeTruthy();
  expect(screen.queryByRole("status", { name: "Flash navigation" })).toBeNull();
  treeKey("Escape");
  expect(screen.queryByRole("tree")).toBeNull();
});
