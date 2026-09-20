/** @vitest-environment happy-dom */

import type { OverviewFolder } from "@symmetria/fm-core/overview/model";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { OverviewModel } from "../../src/overview/useOverview.ts";
import { FileTree } from "../../src/tree/FileTree.tsx";
import type { TreeRecord, TreeShape } from "../../src/tree/state.ts";
import type { TreePort } from "../../src/tree/useTreeMode.ts";
import { treeEntry } from "./tree-support.ts";

/**
 * The tree as a HOST mounts it — directly, not through `App`.
 *
 * `App` passes every prop the panel wants, so a suite driven through it can
 * never tell a default apart from an explicit value. A host such as Mesura Code
 * mounts `FileTree` alone, with no Miller view to return to, no scanner whose
 * budgets a Scope popover could describe, and a composer that must keep focus
 * when the panel mounts. These are the seams that host relies on.
 */

afterEach(cleanup);

// A stray element must not outlive a failing assertion; cleanup only removes
// testing-library containers.
let stray: HTMLElement | null = null;
afterEach(() => {
  stray?.remove();
  stray = null;
});

const ROOT = "/home/jc";

function folder(path: string, depth: number, entries: OverviewFolder["entries"]): OverviewFolder {
  return { path, depth, entries, status: "Loaded" };
}

function model(): OverviewModel {
  return {
    folders: new Map([
      [ROOT, folder(ROOT, 0, [treeEntry("src", "directory"), treeEntry("notes.txt")])],
      [`${ROOT}/src`, folder(`${ROOT}/src`, 1, [treeEntry("beta.ts")])],
    ]),
    loading: false,
    inspected: 3,
    include: vi.fn(),
  };
}

function record(): TreeRecord {
  return {
    shape: { selected: ROOT, collapsed: new Set(), preset: null, checkpoint: null },
    anchor: null,
    pendingReveal: null,
  };
}

function port(): TreePort {
  return { connect: () => () => undefined, select: () => undefined };
}

it("leaves focus where it was when the host mounts it with autoFocus off", () => {
  const input = document.createElement("input");
  document.body.append(input);
  stray = input;
  input.focus();
  render(
    <FileTree
      root={ROOT}
      model={model()}
      port={port()}
      record={record()}
      onOpen={() => undefined}
      autoFocus={false}
    />,
  );
  expect(screen.getByRole("tree")).toBeTruthy();
  expect(document.activeElement).toBe(input);
});

it("shows no Miller button when the host has no Miller view", () => {
  render(
    <FileTree
      root={ROOT}
      model={model()}
      port={port()}
      record={record()}
      onOpen={() => undefined}
    />,
  );
  expect(screen.queryByRole("button", { name: /Miller/ })).toBeNull();
});

it("shows no Scope popover when the host's model is not a scan", () => {
  render(
    <FileTree
      root={ROOT}
      model={model()}
      port={port()}
      record={record()}
      onOpen={() => undefined}
      showScope={false}
    />,
  );
  expect(document.querySelector(".file-tree .overview-scope")).toBeNull();
});

it("reports the shape to the host when a disclosure changes it, and only then", () => {
  const onShapeChange = vi.fn<(shape: TreeShape) => void>();
  const view = render(
    <FileTree
      root={ROOT}
      model={model()}
      port={port()}
      record={record()}
      onOpen={() => undefined}
      onShapeChange={onShapeChange}
    />,
  );
  const settled = onShapeChange.mock.calls.length;
  expect(settled).toBe(1);
  // A fresh model() each render is deliberate: the new folders Map identity
  // re-runs the prune effect, which re-creates an equal shape object. That is
  // the path sameShape guards; reusing one model would make this vacuous.
  view.rerender(
    <FileTree
      root={ROOT}
      model={model()}
      port={port()}
      record={record()}
      onOpen={() => undefined}
      onShapeChange={onShapeChange}
    />,
  );
  expect(onShapeChange.mock.calls.length).toBe(settled);
  fireEvent.click(screen.getByRole("button", { name: "Collapse src" }));
  expect(onShapeChange.mock.calls.length).toBe(settled + 1);
  const shape = onShapeChange.mock.lastCall?.[0];
  expect(shape).toBeTruthy();
  expect([...(shape?.collapsed ?? [])]).toEqual([`${ROOT}/src`]);
});

it("shows the Refresh button only when the host's model can refresh", () => {
  const first = render(
    <FileTree
      root={ROOT}
      model={model()}
      port={port()}
      record={record()}
      onOpen={() => undefined}
    />,
  );
  expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  first.unmount();
  const refresh = vi.fn();
  render(
    <FileTree
      root={ROOT}
      model={{ ...model(), refresh }}
      port={port()}
      record={record()}
      onOpen={() => undefined}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(refresh).toHaveBeenCalledTimes(1);
});
