/** @vitest-environment happy-dom */
import { success } from "@symmetria/fm-core/contract";
import { decodeOverviewRequest, type OverviewEntry } from "@symmetria/fm-core/overview/contract";
import type { OverviewFolder } from "@symmetria/fm-core/overview/model";
import { waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  OverviewSession,
  type OverviewSnapshot,
  representedEntries,
} from "../../src/overview/session.ts";
import { deferred } from "./deferred.ts";
import { installBridge } from "./support.ts";

function fullSnapshot(): OverviewSnapshot {
  const entry = (name: string, kind: OverviewEntry["kind"]): OverviewEntry => ({
    name,
    kind,
    isHidden: false,
    isSymlink: false,
  });
  const folders = new Map<string, OverviewFolder>();
  const branches = Array.from({ length: 5 }, (_, i) => entry(`child${i}`, "directory"));
  folders.set("/root", { path: "/root", depth: 0, status: "Loaded", entries: branches });
  for (const branch of branches) {
    const path = `/root/${branch.name}`;
    folders.set(path, {
      path,
      depth: 1,
      status: "Loaded",
      entries: Array.from({ length: 999 }, (_, i) => entry(`file${i}`, "file")),
    });
  }
  return { folders, loading: false, inspected: 5000 };
}

it("revalidates an unchanged full snapshot without losing cached entries", async () => {
  installBridge();
  const seed = fullSnapshot();
  let latest = seed;
  Object.assign(window.symmetriaFm ?? {}, {
    overview: async (raw: unknown) => {
      const request = decodeOverviewRequest(raw);
      if (!request.ok) return request;
      const all = seed.folders.get(request.value.path)?.entries ?? [];
      const entries = all.slice(0, request.value.limit);
      return success({
        entries,
        inspected: entries.length,
        truncated: entries.length < all.length,
      });
    },
  });
  const session = new OverviewSession(
    "/root",
    false,
    (snapshot) => {
      latest = snapshot;
    },
    seed,
  );
  session.start();
  try {
    await waitFor(() => expect(latest.loading).toBe(false));
    expect(representedEntries(latest.folders)).toBe(5000);
    expect(latest.inspected).toBe(5000);
    expect([...latest.folders.values()].every((folder) => folder.status === "Loaded")).toBe(true);
  } finally {
    session.stop();
  }
});

it("charges a removed branch's completed inspection before discarding its reply", async () => {
  installBridge();
  const seed = fullSnapshot();
  let latest = seed;
  const root = deferred();
  const removed = deferred();
  const read = vi.fn(async (raw: unknown) => {
    const request = decodeOverviewRequest(raw);
    if (!request.ok) return request;
    const { path, limit } = request.value;
    if (path === "/root") await root.promise;
    if (path === "/root/child0") await removed.promise;
    const entries = (seed.folders.get(path)?.entries ?? [])
      .filter((entry) => path !== "/root" || entry.name !== "child0")
      .slice(0, limit);
    return success({ entries, inspected: entries.length, truncated: false });
  });
  Object.assign(window.symmetriaFm ?? {}, { overview: read });
  const session = new OverviewSession(
    "/root",
    false,
    (snapshot) => {
      latest = snapshot;
    },
    seed,
  );
  session.start();
  try {
    await waitFor(() => expect(read).toHaveBeenCalledTimes(6));
    root.resolve();
    await waitFor(() => expect(latest.folders.has("/root/child0")).toBe(false));
    removed.resolve();
    await waitFor(() => expect(latest.loading).toBe(false));
    expect(latest.inspected).toBe(4999);
    expect(representedEntries(latest.folders)).toBe(4000);
  } finally {
    root.resolve();
    removed.resolve();
    session.stop();
  }
});
