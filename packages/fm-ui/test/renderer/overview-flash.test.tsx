/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../../src/App.tsx";
import { mockTextRanges } from "./flash-text-geometry.ts";
import { cursorIn, installBridge } from "./support.ts";

beforeEach(() => {
  mockTextRanges();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(568);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.matches(".connected-groups,.overview-graph-frame"))
      return new DOMRect(0, 32, 800, 568);
    if (this.matches(".overview-minimap-surface")) return new DOMRect(700, 48, 84, 160);
    const row = this.closest<HTMLElement>("[data-entry]");
    const path = row?.dataset.entry;
    const rows = new Map([
      ["/home/jc/notes.txt", [50, 100, 140, 24]],
      ["/home/jc/todo.txt", [1200, 130, 140, 24]],
      ["/home/jc/projects", [50, 150, 140, 24]],
      ["/home/jc/projects/beta.md", [300, 230, 140, 24]],
      ["/home/jc/projects/alpha", [300, 200, 140, 24]],
      ["/home/jc/many", [710, 80, 70, 24]],
    ]);
    const coordinates = rows.get(path ?? "");
    if (coordinates) return new DOMRect(...coordinates);
    const header =
      this.closest<HTMLElement>("[data-basename]")?.closest<HTMLElement>("[data-group]");
    if (header?.dataset.group === "/home/jc/projects") return new DOMRect(300, 170, 140, 24);
    if (header?.dataset.group === "/home/jc") return new DOMRect(30, 40, 140, 24);
    return new DOMRect();
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function open() {
  const log = installBridge();
  const bridge = window.symmetriaFm;
  if (!bridge) throw new Error("missing bridge");
  const reads = vi.spyOn(bridge, "overview");
  render(<App startPath="/home/jc" />);
  await waitFor(() =>
    expect(screen.getByTestId("column-current").textContent).toContain("projects"),
  );
  fireEvent.keyDown(window, { key: "o", ctrlKey: true });
  await screen.findByTestId("connected-groups");
  await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
  return { ...log, reads };
}
function key(value: string) {
  fireEvent.keyDown(document.activeElement ?? window, {
    key: value,
    shiftKey: value.length === 1 && value !== value.toLowerCase(),
  });
}
async function flash(query: string) {
  key("s");
  await screen.findByRole("status", { name: "Flash navigation" });
  for (const character of query) key(character);
}
function labels() {
  return [...document.querySelectorAll<HTMLElement>("[data-flash-label]")];
}
function selected() {
  return screen.getByTestId("connected-groups").dataset.selected;
}
function jump(path: string) {
  const label = labels().find((node) => node.dataset.flashPath === path)?.dataset.flashLabel;
  if (!label) throw new Error(`missing label for ${path}`);
  for (const character of label) key(character);
}
it("starts flash from overview navigation and keeps s as text while searching", async () => {
  await open();
  await flash("");
  key("Escape");
  expect(screen.queryByRole("status", { name: "Flash navigation" })).toBeNull();
  key("/");
  const input = screen.getByRole("textbox", { name: "Search loaded paths" });
  fireEvent.keyDown(input, { key: "s" });
  expect(screen.queryByRole("status", { name: "Flash navigation" })).toBeNull();
});
it("labels unique visible names while excluding offscreen and minimap-covered targets", async () => {
  await open();
  await flash("o");
  expect(
    labels()
      .map((node) => node.dataset.flashPath)
      .sort(),
  ).toEqual(["/home/jc/notes.txt", "/home/jc/projects"]);
  key("Escape");
  await flash("many");
  expect(labels()).toHaveLength(0);
});
it("narrows visible basename matches without regard to case", async () => {
  await open();
  await flash("BETA");
  expect(labels().map((node) => node.dataset.flashPath)).toEqual(["/home/jc/projects/beta.md"]);
  expect(screen.getByRole("status", { name: "Flash navigation" }).textContent).toContain("beta");
});
it("selects the labeled target without activating it or reading new scope", async () => {
  const log = await open();
  const reads = log.reads.mock.calls.length;
  await flash("beta");
  jump("/home/jc/projects/beta.md");
  expect(selected()).toBe("/home/jc/projects/beta.md");
  expect(screen.queryByRole("status", { name: "Flash navigation" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "Folder overview" })).toBeTruthy();
  expect(log.reads).toHaveBeenCalledTimes(reads);
  expect(log.ops).toEqual([]);
});
it("edits the query with Backspace and gives flash Escape precedence over Details", async () => {
  await open();
  const details = screen.getByText("Details").closest("details");
  details?.setAttribute("open", "");
  await flash("beta");
  key("Backspace");
  expect(screen.getByRole("status", { name: "Flash navigation" }).textContent).toContain("bet");
  key("Escape");
  expect(details?.hasAttribute("open")).toBe(true);
  expect(selected()).toBe("/home/jc");
  expect(screen.getByRole("dialog", { name: "Folder overview" })).toBeTruthy();
});
it("cancels captured labels before scrolling can make a label stale", async () => {
  await open();
  await flash("beta");
  const label = labels()[0]?.dataset.flashLabel;
  const graph = screen.getByTestId("connected-groups");
  graph.scrollTop = 100;
  fireEvent.scroll(graph);
  expect(screen.queryByRole("status", { name: "Flash navigation" })).toBeNull();
  expect(labels()).toHaveLength(0);
  expect(selected()).toBe("/home/jc");
  expect(label).toBeTruthy();
});
it("restores retained search feedback with the position of the flash selection", async () => {
  await open();
  key("/");
  const input = screen.getByRole("textbox", { name: "Search loaded paths" });
  fireEvent.change(input, { target: { value: "projects/" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByRole("status", { name: "Search results" }).textContent).toContain("1 / 2");
  await flash("beta");
  expect(screen.queryByRole("status", { name: "Search results" })).toBeNull();
  jump("/home/jc/projects/beta.md");
  expect(screen.getByRole("status", { name: "Search results" }).textContent).toContain("2 / 2");
});

it("ignores held keys, composition, and modifier-only events while accepting AltGr text", async () => {
  await open();
  fireEvent.keyDown(window, { key: "s", repeat: true });
  expect(screen.queryByRole("status", { name: "Flash navigation" })).toBeNull();
  await flash("");
  for (const modifier of ["Control", "Alt", "Meta", "Shift", "AltGraph"]) {
    fireEvent.keyDown(document.activeElement ?? window, {
      key: modifier,
      ctrlKey: true,
      altKey: true,
      metaKey: true,
    });
    expect(screen.getByRole("status", { name: "Flash navigation" })).toBeTruthy();
  }
  const altGraph = new KeyboardEvent("keydown", {
    key: "b",
    ctrlKey: true,
    altKey: true,
    bubbles: true,
  });
  vi.spyOn(altGraph, "getModifierState").mockImplementation((name) => name === "AltGraph");
  fireEvent(document.activeElement ?? window, altGraph);
  for (const character of "eta") key(character);
  const label = labels()[0]?.dataset.flashLabel;
  fireEvent.keyDown(window, { key: label, repeat: true });
  fireEvent.keyDown(window, { key: label, isComposing: true });
  expect(selected()).toBe("/home/jc");
  jump("/home/jc/projects/beta.md");
  expect(selected()).toBe("/home/jc/projects/beta.md");
});
it("cancels flash and lets the minimap shortcut continue", async () => {
  await open();
  await flash("beta");
  // Happy DOM aliases AltGraph to Alt; a deliberate Alt shortcut is not AltGr text.
  const shortcut = new KeyboardEvent("keydown", { key: "m", altKey: true });
  vi.spyOn(shortcut, "getModifierState").mockReturnValue(false);
  fireEvent(window, shortcut);
  expect(screen.queryByRole("status", { name: "Flash navigation" })).toBeNull();
  expect(document.querySelector(".overview-minimap-surface")).toBeNull();
  expect(selected()).toBe("/home/jc");
});
it("cancels on resize, focus leaving overview, and zoom changes", async () => {
  await open();
  await flash("beta");
  fireEvent(window, new Event("resize"));
  expect(labels()).toHaveLength(0);
  await flash("beta");
  fireEvent.focusIn(document.body);
  expect(labels()).toHaveLength(0);
  await flash("beta");
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(labels()).toHaveLength(0);
  expect(selected()).toBe("/home/jc");
});
it("checks geometry again before resolving a key even without a scroll event", async () => {
  await open();
  await flash("beta");
  const label = labels()[0]?.dataset.flashLabel;
  screen.getByTestId("connected-groups").scrollLeft = 40;
  key(label ?? "a");
  expect(labels()).toHaveLength(0);
  expect(selected()).toBe("/home/jc");
});
it("resets captured targets when the overview closes", async () => {
  await open();
  await flash("beta");
  fireEvent.click(screen.getByRole("button", { name: "Close · Esc" }));
  fireEvent.keyDown(window, { key: "o", ctrlKey: true });
  await screen.findByTestId("connected-groups");
  expect(screen.queryByRole("status", { name: "Flash navigation" })).toBeNull();
  key("s");
  expect(screen.getByRole("status", { name: "Flash navigation" }).textContent).not.toContain(
    "beta",
  );
});

it("puts the jump label after the matched glyphs and restores normal presentation on exit", async () => {
  await open();
  await flash("be");
  const label = labels().find((node) => node.dataset.flashPath === "/home/jc/projects/beta.md");
  expect(label?.style.left).toBe("316px");
  expect(label?.style.fontSize).toBe("14px");
  expect(label?.style.lineHeight).toBe("24px");
  expect(document.querySelector(".overview-flash-match")?.textContent).toBe("beta.md");
  expect(document.querySelector(".overview-graph-frame")?.getAttribute("data-flash-mode")).toBe(
    "true",
  );
  expect(document.querySelector<HTMLElement>(".overview-flash-match")?.style.clipPath).toBe(
    'path("M 0 0 H 16 V 24 H 0 Z")',
  );
  key("t");
  expect(labels()[0]?.style.left).toBe("324px");
  key("Escape");
  expect(document.querySelector(".overview-flash-match")).toBeNull();
  expect(document.querySelector(".overview-graph-frame")?.getAttribute("data-flash-mode")).toBe(
    "false",
  );
});
it("shows an empty-result instruction when there are no matching names", async () => {
  await open();
  await flash("zz");
  expect(screen.getByRole("status", { name: "Flash navigation" }).textContent).toContain(
    "No matching names",
  );
});

it("returns flash key ownership to Miller after closing overview", async () => {
  const log = await open();
  await flash("beta");
  key("Escape");
  expect(screen.queryByRole("status", { name: "Flash navigation" })).toBeNull();
  key("Escape");
  expect(screen.queryByRole("dialog", { name: "Folder overview" })).toBeNull();
  key("s");
  expect(screen.getByTestId("status-flash")).toBeTruthy();
  key("n");
  key("a");
  await waitFor(() => expect(cursorIn("column-current")).toBe("notes.txt"));
  expect(screen.queryByTestId("status-flash")).toBeNull();
  expect(log.ops).toEqual([]);
});
