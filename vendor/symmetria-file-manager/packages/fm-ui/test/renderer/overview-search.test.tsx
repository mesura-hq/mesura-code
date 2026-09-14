/** @vitest-environment happy-dom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../../src/App.tsx";
import { useSearchSession } from "../../src/useSearch.ts";
import { installBridge } from "./support.ts";

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
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
function graph() {
  return screen.getByTestId("connected-groups");
}
function selected() {
  return graph().dataset.selected;
}
function query(value: string) {
  fireEvent.keyDown(window, { key: "/" });
  const input = screen.getByRole("textbox", { name: "Search loaded paths" });
  fireEvent.change(input, { target: { value } });
  return input;
}
function results() {
  return screen.getByRole("status", { name: "Search results" }).textContent;
}
function confirm(value: string) {
  fireEvent.keyDown(query(value), { key: "Enter" });
}
it("matches unique full paths and treats whitespace as no search", async () => {
  await open();
  const input = query(" /HOME/JC/PROJECTS ");
  expect(results()).toContain("1 / 3");
  fireEvent.change(input, { target: { value: "   " } });
  expect(results()).toContain("0 / 0");
});
it("selects the first result as the query changes without reading the filesystem", async () => {
  const log = await open();
  const reads = log.reads.mock.calls.length;
  const input = query("beta");
  expect(selected()).toBe("/home/jc/projects/beta.md");
  fireEvent.change(input, { target: { value: "notes.txt" } });
  expect(selected()).toBe("/home/jc/notes.txt");
  expect(log.reads).toHaveBeenCalledTimes(reads);
  expect(log.ops).toEqual([]);
});
it("confirms the query while retaining marks and returning dialog focus", async () => {
  await open();
  confirm("beta");
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(graph().querySelector('[data-entry$="beta.md"]')?.getAttribute("data-search-match")).toBe(
    "true",
  );
  expect(document.activeElement).toBe(screen.getByRole("dialog", { name: "Folder overview" }));
});
it("wraps with n and N and reveals a repeated selected result after panning", async () => {
  await open();
  confirm("/home/jc/projects/");
  expect(selected()).toBe("/home/jc/projects/alpha");
  fireEvent.keyDown(window, { key: "n" });
  expect(selected()).toBe("/home/jc/projects/beta.md");
  fireEvent.keyDown(window, { key: "n" });
  expect(selected()).toBe("/home/jc/projects/alpha");
  fireEvent.keyDown(window, { key: "N", shiftKey: true });
  expect(selected()).toBe("/home/jc/projects/beta.md");
  confirm("beta");
  const row = graph().querySelector<HTMLElement>('[data-entry$="beta.md"]');
  if (!row) throw new Error("missing beta row");
  const reveal = vi.fn();
  row.scrollIntoView = reveal;
  graph().scrollTop = 400;
  fireEvent.scroll(graph());
  fireEvent.keyDown(window, { key: "n" });
  expect(reveal).toHaveBeenCalled();
});
it("cancels editing and restores its original selection and camera", async () => {
  await open();
  graph().scrollLeft = 25;
  graph().scrollTop = 40;
  const input = query("beta");
  graph().scrollLeft = 100;
  graph().scrollTop = 200;
  fireEvent.keyDown(input, { key: "Escape" });
  expect(selected()).toBe("/home/jc");
  expect(graph().scrollLeft).toBe(25);
  expect(graph().scrollTop).toBe(40);
  expect(screen.getByRole("dialog", { name: "Folder overview" })).toBeTruthy();
});
it("reports the selected result index and zero for a manual nonmatch", async () => {
  await open();
  confirm("/home/jc/projects/");
  fireEvent.keyDown(window, { key: "n" });
  expect(results()).toContain("2 / 2");
  fireEvent.keyDown(window, { key: "h" });
  expect(results()).toContain("0 / 2");
  fireEvent.keyDown(window, { key: "n" });
  expect(results()).toContain("1 / 2");
});
it("marks matches and aggregates collapsed descendants on the minimap", async () => {
  await open();
  confirm("projects");
  const map = screen.getByRole("img", { name: "Folder overview minimap" });
  const marked = () => [...map.querySelectorAll<SVGElement>("[data-minimap-matches]")];
  expect(marked().reduce((sum, node) => sum + Number(node.dataset.minimapMatches), 0)).toBe(3);
  expect(graph().querySelectorAll('[data-search-match="true"]').length).toBeGreaterThanOrEqual(3);
  fireEvent.click(screen.getByRole("button", { name: "Collapse projects" }));
  expect(marked()).toHaveLength(1);
  expect(marked()[0]?.dataset.minimapMatches).toBe("3");
  expect(marked()[0]?.getAttribute("data-minimap-match-group")).toBe("/home/jc/projects");
});
it("preserves a surviving result by path when a watcher inserts an earlier match", async () => {
  const log = await open();
  confirm("/home/jc/projects/");
  fireEvent.keyDown(window, { key: "n" });
  expect(selected()).toBe("/home/jc/projects/beta.md");
  graph().scrollTop = 123;
  const watch = log.watched.find(
    (id) => id.startsWith("overview:") && id.endsWith(":/home/jc/projects"),
  );
  if (!watch) throw new Error("missing overview watch");
  await act(async () => {
    log.addEntryFirst("/home/jc/projects", "aaa.txt");
    log.emitChange(watch);
  });
  await waitFor(() => expect(results()).toContain("3 / 3"));
  expect(selected()).toBe("/home/jc/projects/beta.md");
  expect(graph().scrollTop).toBe(123);
  fireEvent.keyDown(window, { key: "n" });
  expect(selected()).toBe("/home/jc/projects/aaa.txt");
});

it("describes aggregated minimap results accessibly after collapse", async () => {
  await open();
  confirm("projects");
  const map = screen.getByRole("img", { name: "Folder overview minimap" });
  const description = () =>
    document.getElementById(map.getAttribute("aria-describedby") ?? "")?.textContent;
  expect(description()).toContain("3 matching paths");
  expect(description()).toContain("current result");
  fireEvent.click(screen.getByRole("button", { name: "Collapse projects" }));
  expect(description()).toContain("3 matching paths in 1 groups");
  expect(description()).toContain("/home/jc/projects: 3");
});
it("keeps an editing query stationary during a watcher refresh", async () => {
  const log = await open();
  const input = query("/home/jc/projects/");
  graph().scrollTop = 90;
  const before = selected();
  const watch = log.watched.find(
    (id) => id.startsWith("overview:") && id.endsWith(":/home/jc/projects"),
  );
  if (!watch) throw new Error("missing overview watch");
  await act(async () => {
    log.addEntryFirst("/home/jc/projects", "000.txt");
    log.emitChange(watch);
  });
  await waitFor(() => expect(results()).toContain("2 / 3"));
  expect(selected()).toBe(before);
  expect(graph().scrollTop).toBe(90);
  expect(document.activeElement).toBe(input);
});
it.each(["close", "focus"])("resets search across a %s boundary", async (boundary) => {
  await open();
  confirm("projects");
  if (boundary === "close") {
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
  } else {
    screen.getByText("Details").closest("details")?.setAttribute("open", "");
    fireEvent.click(screen.getByRole("button", { name: "Focus here" }));
  }
  await screen.findByTestId("connected-groups");
  expect(screen.queryByRole("status", { name: "Search results" })).toBeNull();
  expect(graph().querySelectorAll('[data-search-match="true"]')).toHaveLength(0);
});
it("keeps empty search navigation and clearing free of reads or file operations", async () => {
  const log = await open();
  const reads = log.reads.mock.calls.length;
  const listings = log.listed.length;
  confirm("never-a-match");
  const before = selected();
  for (const key of ["n", "N"]) fireEvent.keyDown(window, { key, shiftKey: key === "N" });
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(selected()).toBe(before);
  expect(log.reads).toHaveBeenCalledTimes(reads);
  expect(log.listed).toHaveLength(listings);
  expect(log.ops).toEqual([]);
});

it("uses a removed result as a boundary for the next explicit step", () => {
  const choose = vi.fn();
  const targets = ["a", "b", "c"].map((name) => ({ key: `/root/${name}`, text: `/root/${name}` }));
  const hook = renderHook(
    ({ entries }) =>
      useSearchSession({ targets: entries, scope: "/root", selected: "/root/b", choose }),
    { initialProps: { entries: targets } },
  );
  act(() => {
    hook.result.current.open();
    hook.result.current.setQuery("/root/");
  });
  act(() => hook.result.current.goNext());
  expect(choose).toHaveBeenLastCalledWith("/root/b");
  act(() => hook.result.current.confirm());
  choose.mockClear();
  hook.rerender({ entries: targets.filter((target) => target.key !== "/root/b") });
  expect(choose).not.toHaveBeenCalled();
  act(() => hook.result.current.goNext());
  expect(choose).toHaveBeenLastCalledWith("/root/c");
});
