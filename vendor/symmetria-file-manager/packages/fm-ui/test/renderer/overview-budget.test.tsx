/** @vitest-environment happy-dom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useOverview } from "../../src/overview/useOverview.ts";
import { installBridge } from "./support.ts";

afterEach(cleanup);
it("caps initial traversal at four concurrent reads, 512 reads, depth eight and 5000 inspected entries", async () => {
  installBridge();
  let active = 0;
  let peak = 0;
  let inspected = 0;
  const paths: string[] = [];
  Object.assign(window.symmetriaFm ?? {}, {
    overview: vi.fn(async (request: { path: string; limit: number }) => {
      paths.push(request.path);
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      const count = Math.min(50, request.limit);
      inspected += count;
      return {
        ok: true,
        value: {
          entries: Array.from({ length: count }, (_, i) => ({
            name: `dir${i}`,
            kind: "directory",
            isSymlink: false,
            isHidden: false,
          })),
          inspected: count,
          truncated: count === request.limit,
        },
      };
    }),
  });
  const { result } = renderHook(() => useOverview("/root", false));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(paths.length).toBeGreaterThan(1);
  expect(paths.length).toBeLessThanOrEqual(512);
  expect(peak).toBeLessThanOrEqual(4);
  expect(inspected).toBeLessThanOrEqual(5000);
  expect(paths.every((path) => path.split("/").length <= 9)).toBe(true);
});

it.each([6, 8])("stops a narrow deep tree at configured depth %i", async (depth) => {
  installBridge();
  const paths: string[] = [];
  Object.assign(window.symmetriaFm ?? {}, {
    overview: async (request: { path: string }) => {
      paths.push(request.path);
      return {
        ok: true,
        value: {
          entries: [{ name: "nested", kind: "directory", isSymlink: false, isHidden: false }],
          inspected: 1,
          truncated: false,
        },
      };
    },
  });
  const { result } = renderHook(() => useOverview("/root", false, depth));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(paths).toHaveLength(depth);
  expect(
    [...result.current.folders.values()].some(
      (folder) => folder.depth === depth && folder.status === "Depth limit reached",
    ),
  ).toBe(true);
});
it("stops broad empty branches at 512 reads", async () => {
  installBridge();
  const paths: string[] = [];
  Object.assign(window.symmetriaFm ?? {}, {
    overview: async (request: { path: string }) => {
      paths.push(request.path);
      const entries =
        request.path === "/root"
          ? Array.from({ length: 600 }, (_, i) => ({
              name: `d${i}`,
              kind: "directory",
              isSymlink: false,
              isHidden: false,
            }))
          : [];
      return { ok: true, value: { entries, inspected: entries.length, truncated: false } };
    },
  });
  const { result } = renderHook(() => useOverview("/root", false));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(paths).toHaveLength(512);
  expect(
    [...result.current.folders.values()].some(
      (folder) => folder.status === "Traversal budget reached",
    ),
  ).toBe(true);
  expect(
    [...result.current.folders.values()].reduce(
      (count, folder) => count + folder.entries.length,
      0,
    ),
  ).toBe(600);
});

it("queues an explicit excluded folder during an active read without duplicate work", async () => {
  installBridge();
  let release: () => void = () => undefined;
  const paths: string[] = [];
  Object.assign(window.symmetriaFm ?? {}, {
    overview: async (request: { path: string }) => {
      paths.push(request.path);
      if (request.path === "/root/active")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      const entries =
        request.path === "/root"
          ? ["active", "node_modules"].map((name) => ({
              name,
              kind: "directory",
              isSymlink: false,
              isHidden: false,
            }))
          : [];
      return { ok: true, value: { entries, inspected: entries.length, truncated: false } };
    },
  });
  const { result } = renderHook(() => useOverview("/root", false));
  await waitFor(() => expect(paths).toContain("/root/active"));
  act(() => {
    result.current.include("/root/node_modules");
    result.current.include("/root/node_modules");
  });
  await waitFor(() => expect(paths).toContain("/root/node_modules"));
  act(() => release());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(paths.filter((path) => path === "/root/node_modules")).toHaveLength(1);
});
