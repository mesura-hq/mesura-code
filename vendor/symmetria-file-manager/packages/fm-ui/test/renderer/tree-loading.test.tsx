/** @vitest-environment happy-dom */
import type { OverviewFolder } from "@symmetria/fm-core/overview/model";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FileTree } from "../../src/tree/FileTree.tsx";
import { TreeStateCache } from "../../src/tree/state.ts";
import type { TreeController } from "../../src/tree/useTreeMode.ts";
import { treeEntry, treeRow } from "./tree-support.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function loadingTree(selected: string) {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(240);
  const root = "/root";
  const record = new TreeStateCache().get("tab", root, false);
  record.shape.selected = selected;
  record.pendingReveal = selected;
  const folders = new Map<string, OverviewFolder>([
    [
      root,
      {
        path: root,
        depth: 0,
        status: "Loaded",
        entries: [
          treeEntry("a", "directory"),
          ...Array.from({ length: 50 }, (_, i) => treeEntry(`z${String(i).padStart(2, "0")}`)),
        ],
      },
    ],
  ]);
  folders.set("/root/a", { path: "/root/a", depth: 1, status: "Depth limit reached", entries: [] });
  let controller: TreeController | undefined;
  const props = {
    root,
    record,
    onOpen: vi.fn(),
    onMiller: vi.fn(),
    port: {
      connect: (next: TreeController) => {
        controller = next;
        return () => {};
      },
      select: () => {},
    },
  };
  const include = vi.fn();
  const model = { folders, loading: true, inspected: 51, include };
  const { rerender } = render(<FileTree {...props} model={model} />);
  return {
    record,
    include,
    reveal: (path: string) => act(() => controller?.reveal(path)),
    command: (name: Parameters<TreeController["command"]>[0]) =>
      act(() => controller?.command(name)),
    publish: (loading: boolean, count = 1, status = "Loaded") => {
      folders.set("/root/a", {
        path: "/root/a",
        depth: 1,
        status,
        entries: Array.from({ length: count }, (_, i) => treeEntry(`new${i}`)),
      });
      rerender(<FileTree {...props} model={{ ...model, folders: new Map(folders), loading }} />);
    },
  };
}

it.each([
  ["/root/a", "down", "/root/z00"],
  ["/root/z49", "up", "/root/z48"],
] as const)(
  "keeps user navigation from %s while discovery publishes",
  (start, command, expected) => {
    const fixture = loadingTree(start);
    fixture.command(command);
    fixture.publish(true);
    expect(treeRow(expected).getAttribute("aria-selected")).toBe("true");
    fixture.publish(false);
    expect(treeRow(expected).getAttribute("aria-selected")).toBe("true");
    expect(fixture.record.pendingReveal).toBeNull();
  },
);

it("settles an interrupted page on its selected row when discovery changes the projection", () => {
  const fixture = loadingTree("/root/a");
  fixture.command("page-down");
  const path = screen.getByRole("tree").querySelector<HTMLElement>('[aria-selected="true"]')
    ?.dataset.path;
  if (!path) throw new Error("Missing selected path");
  fixture.publish(true);
  const tree = screen.getByRole("tree");
  const row = treeRow(path);
  expect(row.getAttribute("aria-selected")).toBe("true");
  const top = Number.parseFloat(row.style.top);
  expect(top).toBeGreaterThanOrEqual(tree.scrollTop);
  expect(top + 24).toBeLessThanOrEqual(tree.scrollTop + tree.clientHeight);
});

it("lets pointer navigation replace an initial reveal before discovery settles", () => {
  const fixture = loadingTree("/root/a");
  fireEvent.click(treeRow("/root/z03"));
  fixture.publish(false);
  expect(treeRow("/root/z03").getAttribute("aria-selected")).toBe("true");
});

it("keeps a visible cursor in view when a large discovery batch inserts earlier rows", () => {
  const fixture = loadingTree("/root/a");
  fixture.command("down");
  fixture.publish(true, 50);
  const tree = screen.getByRole("tree");
  const row = treeRow("/root/z00");
  const top = Number.parseFloat(row.style.top);
  expect(row.getAttribute("aria-selected")).toBe("true");
  expect(top).toBeGreaterThanOrEqual(tree.scrollTop);
  expect(top + 24).toBeLessThanOrEqual(tree.scrollTop + tree.clientHeight);
});

it("does not reapply a deep reveal after the user moves during its ancestor read", () => {
  const fixture = loadingTree("/root/a");
  fixture.reveal("/root/a/new0");
  expect(fixture.include).toHaveBeenCalledWith("/root/a");
  fixture.command("down");
  const selected = screen.getByRole("tree").querySelector<HTMLElement>('[aria-selected="true"]')
    ?.dataset.path;
  fixture.publish(false);
  expect(
    screen.getByRole("tree").querySelector<HTMLElement>('[aria-selected="true"]')?.dataset.path,
  ).toBe(selected);
  expect(fixture.record.pendingReveal).toBeNull();
});

it.each(["Traversal budget reached", "Unreadable: permission denied"])(
  "ends an explicit reveal when the ancestor reports %s",
  (status) => {
    const fixture = loadingTree("/root/a");
    fixture.reveal("/root/a/new0");
    fixture.include.mockClear();
    fixture.publish(false, 0, status);
    expect(fixture.include).not.toHaveBeenCalled();
    expect(fixture.record.pendingReveal).toBeNull();
    expect(treeRow("/root/a").getAttribute("aria-selected")).toBe("true");
  },
);
