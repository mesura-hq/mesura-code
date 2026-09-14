import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createOverviewViewStore,
  decodeStoredOverviewView,
  overviewViewStorageKey,
  type StoredOverviewView,
} from "./overviewViewStorage";

const ENV = EnvironmentId.make("env-1");
const CWD = "/home/jc/project";

function memoryStorage() {
  const values = new Map<string, StoredOverviewView>();
  let writes = 0;
  return {
    storage: {
      read: (key: string) => values.get(key) ?? null,
      write: (key: string, value: StoredOverviewView) => {
        values.set(key, value);
        writes += 1;
        return true;
      },
    },
    values,
    writeCount: () => writes,
  };
}

const VIEW = {
  selected: `${CWD}/src`,
  collapsed: new Set([`${CWD}/dist`]),
  zoom: 1.5,
  origin: { x: 10, y: -20 },
  scroll: { x: 0, y: 300 },
  boxes: new Map([[`${CWD}/src`, { x: 1, y: 2, width: 200, height: 80 }]]),
};

describe("overview view storage", () => {
  it("keys the view by environment and project root", () => {
    expect(overviewViewStorageKey(ENV, CWD)).toBe(`mesura.fileTreeOverview.env-1:${CWD}`);
  });

  it("round-trips the camera, the selection and the box layout", () => {
    const memory = memoryStorage();
    const store = createOverviewViewStore(memory.storage, 0);
    store.save(ENV, CWD, VIEW);
    store.flush();
    expect(store.load(ENV, CWD)).toEqual(VIEW);
    expect(store.load(ENV, "/elsewhere")).toBeNull();
    // What sits in storage is plain data, not Sets and Maps.
    expect(memory.values.get(overviewViewStorageKey(ENV, CWD))).toEqual({
      selected: VIEW.selected,
      collapsed: [`${CWD}/dist`],
      zoom: 1.5,
      origin: { x: 10, y: -20 },
      scroll: { x: 0, y: 300 },
      boxes: [[`${CWD}/src`, { x: 1, y: 2, width: 200, height: 80 }]],
    });
  });

  it("forgets a stored value that fails the schema", () => {
    expect(decodeStoredOverviewView(null)).toBeNull();
    expect(decodeStoredOverviewView({ selected: CWD })).toBeNull();
    expect(decodeStoredOverviewView({ ...VIEW, collapsed: [], boxes: [], zoom: "1" })).toBeNull();
  });

  it("writes a burst of saves once, with the last view", () => {
    const memory = memoryStorage();
    const store = createOverviewViewStore(memory.storage, 0);
    store.save(ENV, CWD, VIEW);
    store.save(ENV, CWD, { ...VIEW, zoom: 2 });
    store.save(ENV, CWD, { ...VIEW, zoom: 3 });
    expect(memory.writeCount()).toBe(0);
    store.flush();
    expect(memory.writeCount()).toBe(1);
    expect(store.load(ENV, CWD)?.zoom).toBe(3);
    // Nothing pending, nothing written.
    store.flush();
    expect(memory.writeCount()).toBe(1);
  });
});
