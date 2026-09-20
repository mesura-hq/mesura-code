/** @vitest-environment happy-dom */
import type { OverviewFolder } from "@symmetria/fm-core/overview/model";
import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useGraphScene } from "../../src/overview/useGraphScene.ts";
import { useGraphState } from "../../src/overview/useGraphState.ts";

it("restores measured boxes without shifting following siblings", () => {
  const folders = new Map<string, OverviewFolder>(
    ["/root", "/root/a", "/root/b"].map((path) => [
      path,
      { path, depth: path === "/root" ? 0 : 1, status: "Loaded", entries: [] },
    ]),
  );
  const first = renderHook(() => useGraphScene(folders));
  act(() => first.result.current.onMeasure("/root/a", { width: 240, height: 43 }));
  const saved = new Map(
    [...first.result.current.boxes.current].map(([path, { x, y, width, height }]) => [
      path,
      { x, y, width, height },
    ]),
  );
  const expected = first.result.current.groups;
  first.unmount();
  const second = renderHook(() => useGraphScene(folders, saved));
  expect(second.result.current.groups).toEqual(expected);
  second.unmount();
});

it("forgets measurements and collapsed state when directories disappear", () => {
  const root: OverviewFolder = { path: "/root", depth: 0, status: "Loaded", entries: [] };
  const child: OverviewFolder = { ...root, path: "/root/child", depth: 1 };
  const present = new Map([
    [root.path, root],
    [child.path, child],
  ]);
  const absent = new Map([[root.path, root]]);
  const hook = renderHook(
    ({ folders }) => ({
      scene: useGraphScene(folders),
      state: useGraphState("/root", {
        folders,
        loading: false,
        inspected: 0,
        include: () => undefined,
      }),
    }),
    { initialProps: { folders: present } },
  );
  for (let cycle = 0; cycle < 3; cycle++) {
    act(() => {
      hook.result.current.scene.onMeasure(child.path, { width: 240, height: 500 });
      hook.result.current.state.setCollapsed(new Set([child.path]));
    });
    expect(hook.result.current.scene.boxes.current.get(child.path)?.height).toBe(500);
    hook.rerender({ folders: absent });
    act(() => hook.result.current.scene.onMeasure(child.path, { width: 240, height: 600 }));
    expect(hook.result.current.state.collapsed.size).toBe(0);
    expect(hook.result.current.scene.boxes.current.has(child.path)).toBe(false);
    hook.rerender({ folders: present });
    expect(hook.result.current.scene.boxes.current.get(child.path)?.height).toBe(68);
  }
  hook.unmount();
});
