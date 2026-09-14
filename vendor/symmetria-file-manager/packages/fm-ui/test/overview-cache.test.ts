import { expect, it } from "vitest";
import { OverviewCache } from "../src/overview/cache.ts";

it("retains at most three roots and 15000 entries", () => {
  const cache = new OverviewCache();
  const snapshot = {
    folders: new Map([
      [
        "/root",
        {
          path: "/root",
          depth: 0,
          status: "Loaded",
          entries: Array.from({ length: 5000 }, (_, i) => ({
            name: String(i),
            kind: "file" as const,
            isHidden: false,
            isSymlink: false,
          })),
        },
      ],
    ]),
    loading: false,
    inspected: 5000,
  };
  for (const key of ["a", "b", "c", "d"]) cache.save(key, snapshot);
  expect(cache.get("a")).toBeUndefined();
  expect(cache.size).toBe(3);
  expect(cache.entries).toBe(15000);
});

it("retains bounded camera and selection data beside a cached snapshot", () => {
  const cache = new OverviewCache();
  cache.save("root", { folders: new Map(), loading: false, inspected: 0 });
  const view = {
    selected: "/root",
    collapsed: new Set<string>(),
    zoom: 1.2,
    origin: { x: 0, y: 0 },
    scroll: { x: 100, y: 200 },
    boxes: new Map(),
  };
  cache.saveView("root", view);
  expect(cache.get("root")?.view).toEqual(view);
});
