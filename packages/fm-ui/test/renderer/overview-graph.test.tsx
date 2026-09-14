import { ConnectedGroups } from "../../src/overview/ConnectedGroups.tsx";
/** @vitest-environment happy-dom */

import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { App } from "../../src/App.tsx";
import { installBridge } from "./support.ts";

afterEach(cleanup);
async function graph() {
  installBridge();
  render(<App startPath="/home/jc" />);
  fireEvent.keyDown(window, { key: "o", ctrlKey: true });
  return screen.findByTestId("connected-groups");
}
it("shows basenames separately from ancestor paths in graph headers", async () => {
  const view = await graph();
  await waitFor(() => expect(view.querySelector('[data-group="/home/jc/projects"]')).toBeTruthy());
  expect(view.querySelector('[data-group="/home/jc/projects"] [data-basename]')?.textContent).toBe(
    "projects",
  );
});
it("draws two endpoint dots on every graph connector", async () => {
  const view = await graph();
  await waitFor(() => expect(view.querySelectorAll("[data-edge]").length).toBeGreaterThan(0));
  for (const edge of view.querySelectorAll("[data-edge]"))
    expect(edge.querySelectorAll("circle")).toHaveLength(2);
});
it("uses neutral theme tokens on connected groups", async () => {
  await graph();
  const css = readFileSync("src/overview/overview.css", "utf8");
  expect(css).toMatch(/background:\s*var\(--background\)/);
  expect(css).toMatch(/color:\s*var\(--foreground\)/);
});
it("keeps toolbar height at 32 pixels", async () => {
  await graph();
  const css = readFileSync("src/overview/overview.css", "utf8");
  expect(css).toMatch(/\.overview-toolbar\s*\{[^}]*height:\s*32px/);
});
it("zooms without modifying assigned group coordinates", async () => {
  const view = await graph();
  await waitFor(() => expect(view.querySelector("[data-group]")).toBeTruthy());
  const group = view.querySelector("[data-group]");
  const x = group?.getAttribute("data-x");
  const y = group?.getAttribute("data-y");
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(group?.getAttribute("data-x")).toBe(x);
  expect(group?.getAttribute("data-y")).toBe(y);
  expect(view.getAttribute("data-zoom")).toBe("1.2");
});

it("keeps the selected group anchored when preceding measured geometry grows", () => {
  const leaf = (name: string) => ({
    name,
    kind: "directory" as const,
    isHidden: false,
    isSymlink: false,
  });
  const makeModel = (count: number) => ({
    folders: new Map([
      ["/root", { path: "/root", depth: 0, entries: [leaf("a"), leaf("b")], status: "Loaded" }],
      [
        "/root/a",
        {
          path: "/root/a",
          depth: 1,
          entries: Array.from({ length: count }, (_, i) => leaf(String(i))),
          status: "Loaded",
        },
      ],
      ["/root/b", { path: "/root/b", depth: 1, entries: [], status: "Loaded" }],
    ]),
    loading: false,
    inspected: count + 2,
    include: () => undefined,
  });
  const { container, rerender } = render(<ConnectedGroups root="/root" model={makeModel(0)} />);
  const selected = container.querySelector('[data-group="/root/b"] [data-basename]');
  if (!selected) throw new Error("missing group");
  fireEvent.click(selected);
  const viewport = screen.getByTestId("connected-groups");
  let scrollTop = 0;
  Object.defineProperty(viewport, "clientHeight", { value: 568 });
  Object.defineProperty(viewport, "scrollTop", {
    get: () => scrollTop,
    set: (value: number) => {
      const extent = viewport.firstElementChild;
      if (!(extent instanceof HTMLElement)) throw new Error("missing extent");
      const height = Math.max(
        Number.parseFloat(extent.style.height),
        Number.parseFloat(extent.style.minHeight) || 0,
      );
      scrollTop = Math.max(0, Math.min(value, height - 568));
    },
  });
  const before =
    Number(container.querySelector('[data-group="/root/b"]')?.getAttribute("data-y")) -
    viewport.scrollTop;
  rerender(<ConnectedGroups root="/root" model={makeModel(12)} />);
  const after =
    Number(container.querySelector('[data-group="/root/b"]')?.getAttribute("data-y")) -
    viewport.scrollTop;
  expect(after).toBe(before);
});
it("keeps a selected filesystem-root entry mounted outside overscan", () => {
  const model = {
    folders: new Map([
      [
        "/",
        {
          path: "/",
          depth: 0,
          entries: [{ name: "file", kind: "file" as const, isHidden: false, isSymlink: false }],
          status: "Loaded",
        },
      ],
    ]),
    loading: false,
    inspected: 1,
    include: () => undefined,
  };
  const { container } = render(<ConnectedGroups root="/" model={model} />);
  const entry = container.querySelector('[data-entry="/file"]');
  if (!entry) throw new Error("missing entry");
  fireEvent.click(entry);
  const viewport = screen.getByTestId("connected-groups");
  viewport.scrollTop = 5000;
  fireEvent.scroll(viewport);
  expect(container.querySelector('[data-group="/"]')).not.toBeNull();
});

it("renders shared folder and file-type icons in the overview", async () => {
  const view = await graph();
  await waitFor(() =>
    expect(view.querySelector('[data-entry="/home/jc/projects/beta.md"]')).toBeTruthy(),
  );
  expect(
    view.querySelector('[data-group="/home/jc/projects"] [data-basename] [data-icon="folder"]'),
  ).toBeTruthy();
  expect(view.querySelector('[data-entry="/home/jc/projects"] [data-icon="folder"]')).toBeTruthy();
  expect(
    view
      .querySelector('[data-entry="/home/jc/projects/beta.md"] .file-icon use')
      ?.getAttribute("href"),
  ).toContain("markdown");
});
