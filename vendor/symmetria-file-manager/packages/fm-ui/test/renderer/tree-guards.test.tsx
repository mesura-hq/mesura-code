/** @vitest-environment happy-dom */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../../src/App.tsx";
import { installTreeBridge, openTree, treeEntry, treeKey, treeRow } from "./tree-support.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("leaves native control activation available without activating the selected file", async () => {
  const log = await openTree();
  fireEvent.click(treeRow("/home/jc/notes.txt"));
  log.entries.set("/home/jc/node_modules", [treeEntry("included.txt")]);
  const include = screen.getByRole("button", { name: "Include node_modules" });
  include.focus();
  expect(fireEvent.keyDown(include, { key: "Enter" })).toBe(true);
  expect(log.open).not.toHaveBeenCalled();
  // Happy DOM does not synthesize the browser's native click from keydown.
  fireEvent.click(include);
  await waitFor(() => expect(treeRow("/home/jc/node_modules/included.txt")).toBeTruthy());
  const refresh = screen.getByRole("button", { name: "Refresh" });
  refresh.focus();
  expect(fireEvent.keyDown(refresh, { key: "Enter" })).toBe(true);
  const reads = log.overview.mock.calls.length;
  fireEvent.click(refresh);
  await waitFor(() => expect(log.overview.mock.calls.length).toBeGreaterThan(reads));
  const miller = screen.getByRole("button", { name: "Miller · Esc" });
  miller.focus();
  expect(fireEvent.keyDown(miller, { key: " " })).toBe(true);
  fireEvent.click(miller);
  expect(screen.queryByRole("tree")).toBeNull();
  expect(log.open).not.toHaveBeenCalled();
});

it("reports tree coverage instead of Miller selection and keeps host errors visible", async () => {
  await openTree();
  const footer = screen.getByTestId("status-bar");
  await waitFor(() => expect(footer.textContent).toContain("represented entries"));
  expect(footer.textContent).not.toContain("sort:");
  expect(footer.textContent).not.toContain("selected");
  Object.assign(window.symmetriaFm ?? {}, {
    open: async () => ({
      ok: false,
      error: { code: "open_failed", message: "No application available" },
    }),
  });
  fireEvent.click(treeRow("/home/jc/notes.txt"));
  treeKey("Enter");
  await waitFor(() => expect(footer.textContent).toContain("No application available"));
});

it("keeps symlink directories as host-activated leaves and respects the hidden scope", async () => {
  const link = { ...treeEntry("linked", "directory"), isSymlink: true };
  const log = await openTree([link, treeEntry(".private")]);
  const row = treeRow("/home/jc/linked");
  expect(row.hasAttribute("aria-expanded")).toBe(false);
  expect(row.textContent).toContain("link");
  expect(log.overview.mock.calls.some(([request]) => request.path === "/home/jc/linked")).toBe(
    false,
  );
  expect(screen.queryByRole("treeitem", { name: ".private" })).toBeNull();
  fireEvent.click(row);
  treeKey("ArrowRight");
  expect(row.getAttribute("aria-selected")).toBe("true");
  treeKey("Enter");
  await waitFor(() =>
    expect(log.open).toHaveBeenCalledExactlyOnceWith({ path: "/home/jc/linked" }),
  );
  cleanup();
  installTreeBridge([treeEntry(".private")]);
  render(<App startPath="/home/jc" />);
  await waitFor(() => expect(screen.getAllByTestId("row").length).toBeGreaterThan(0));
  treeKey(".");
  treeKey("e", true);
  await waitFor(() => expect(treeRow("/home/jc/.private")).toBeTruthy());
  expect(screen.getByTestId("status-bar").textContent).toContain("hidden shown");
});

it("measures wide names outside the virtual slice and retains width after scrolling", async () => {
  // SAFETY: the fake supplies only the canvas text API that this measurement calls.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () =>
      ({
        measureText: (text: string) => ({
          width: [...text].reduce((sum, character) => sum + (character === "界" ? 13 : 8), 0),
        }),
      }) as CanvasRenderingContext2D,
  );
  const longName = `zz${"界".repeat(80)}.md`;
  await openTree([
    ...Array.from({ length: 600 }, (_, index) => treeEntry(`z${index}.txt`)),
    treeEntry(longName),
  ]);
  const tree = screen.getByRole("tree");
  const canvas = tree.querySelector<HTMLElement>(".tree-canvas");
  if (!canvas) throw new Error("Missing tree canvas");
  await waitFor(() => expect(Number.parseFloat(canvas.style.minWidth)).toBeGreaterThan(1040));
  expect(within(tree).queryByRole("treeitem", { name: longName })).toBeNull();
  const width = canvas.style.minWidth;
  tree.scrollTop = 4000;
  fireEvent.scroll(tree);
  expect(canvas.style.minWidth).toBe(width);
});

it("anchors Scope to the toolbar and gives compact tree controls the shared dark style", async () => {
  const sheets = await Promise.all(
    ["tree/tree.css", "overview/overview.css", "theme/tokens.css"].map((path) =>
      readFile(resolve(import.meta.dirname, "../../src", path), "utf8"),
    ),
  );
  const style = document.createElement("style");
  // Happy DOM does not resolve color-mix. Use a concrete token to test its consumers.
  style.textContent = `${sheets.join("\n")}\n:root { --card: rgb(18, 18, 18); }`;
  document.head.append(style);
  try {
    await openTree();
    const scope = document.querySelector<HTMLElement>(".file-tree .overview-scope");
    const popup = scope?.querySelector<HTMLElement>(".overview-popover");
    expect(scope).not.toBeNull();
    expect(popup).not.toBeNull();
    if (!scope || !popup) throw new Error("Missing scope controls");
    expect(getComputedStyle(scope).position).toBe("static");
    const toolbar = scope.closest("header");
    if (!toolbar) throw new Error("Missing scope toolbar");
    expect(getComputedStyle(toolbar).position).toBe("relative");
    expect(getComputedStyle(popup).top).toBe("100%");
    expect(getComputedStyle(popup).right).toBe("16px");
    const button = screen.getByRole("button", { name: "Miller · Esc" });
    expect(button.closest(".tree-toolbar")).not.toBeNull();
    expect(getComputedStyle(button).backgroundColor).toBe("rgb(18, 18, 18)");
  } finally {
    style.remove();
  }
});
