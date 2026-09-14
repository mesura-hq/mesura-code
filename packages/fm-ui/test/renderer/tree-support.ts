import type { OverviewEntry, OverviewRequest } from "@symmetria/fm-core/overview/contract";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { vi } from "vitest";
import { App, type AppProps } from "../../src/App.tsx";
import { installBridge } from "./support.ts";

export function treeEntry(name: string, kind: OverviewEntry["kind"] = "file"): OverviewEntry {
  return { name, kind, isHidden: name.startsWith("."), isSymlink: false };
}

export function installTreeBridge(extra: readonly OverviewEntry[] = []) {
  const log = installBridge();
  const entries = new Map<string, readonly OverviewEntry[]>([
    [
      "/home/jc",
      [
        treeEntry("src", "directory"),
        treeEntry("empty", "directory"),
        treeEntry("locked", "directory"),
        treeEntry("node_modules", "directory"),
        treeEntry("partial", "directory"),
        treeEntry("notes.txt"),
        ...extra,
      ],
    ],
    ["/home/jc/src", [treeEntry("nested", "directory"), treeEntry("beta.ts")]],
    ["/home/jc/src/nested", [treeEntry("İinteresting long filename.md")]],
    ["/home/jc/empty", []],
    ["/home/jc/partial", [treeEntry("known.txt")]],
  ]);
  const overview = vi.fn(async ({ path }: OverviewRequest) => {
    const found = entries.get(path);
    return found
      ? {
          ok: true,
          value: { entries: found, inspected: found.length, truncated: path.endsWith("/partial") },
        }
      : { ok: false, error: { code: "scan_failed", message: "permission denied" } };
  });
  const originalList = window.symmetriaFm?.list;
  const list = vi.fn(async (request: { path: string }) => {
    const found = entries.get(request.path);
    if (!found && originalList) return originalList(request);
    return {
      ok: true,
      value: {
        entries: (found ?? []).map((entry) => ({ ...entry, size: 0, modifiedMs: 0 })),
        total: found?.length ?? 0,
        streamId: null,
      },
    };
  });
  const open = vi.fn(async () => ({ ok: true, value: null }));
  const trash = vi.fn(async () => ({ ok: true, value: null }));
  const clipboard = vi.fn(async () => ({ ok: true, value: null }));
  Object.assign(window.symmetriaFm ?? {}, { overview, list, open, trash, clipboard });
  return { ...log, overview, list, open, trash, clipboard, entries };
}

export function treeKey(key: string, ctrlKey = false) {
  fireEvent.keyDown(window, { key, ctrlKey });
}

export function treeRow(path: string): HTMLElement {
  const row = within(screen.getByRole("tree"))
    .getAllByRole("treeitem")
    .find((item) => item.dataset.path === path);
  if (!row) throw new Error(`Tree row missing: ${path}`);
  return row;
}

export async function openTree(extra: ReturnType<typeof treeEntry>[] = []) {
  const log = installTreeBridge(extra);
  render(createElement<AppProps>(App, { startPath: "/home/jc" }));
  treeKey("e", true);
  await screen.findByRole("tree");
  await waitFor(() => treeRow("/home/jc/src"));
  return log;
}
