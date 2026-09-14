import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  createTreeShapePersister,
  decodeStoredTreeShape,
  encodeTreeShape,
  projectTreeKey,
  StoredTreeShape,
  treeShapeStorageKey,
} from "./treeShapeStorage";

const ENV = EnvironmentId.make("env-1");
const CWD = "/home/jc/project";
const StoredTreeShapeJson = Schema.fromJsonString(StoredTreeShape);
const encodeJson = Schema.encodeSync(StoredTreeShapeJson);
const decodeJson = Schema.decodeSync(StoredTreeShapeJson);

function memoryStorage(options: { failWrites?: boolean } = {}) {
  const values = new Map<string, unknown>();
  const writes: Array<[string, unknown]> = [];
  let failWrites = options.failWrites ?? false;
  return {
    storage: {
      read: (key: string) => values.get(key) ?? null,
      write: (key: string, value: unknown) => {
        if (failWrites) return false;
        values.set(key, value);
        writes.push([key, value]);
        return true;
      },
    },
    writes,
    seed: (key: string, value: unknown) => values.set(key, value),
    setFailWrites: (fail: boolean) => {
      failWrites = fail;
    },
  };
}

const shapeOf = (selected: string, collapsed: string[]) => ({
  selected,
  collapsed: new Set(collapsed),
  preset: null,
  checkpoint: null,
});

describe("tree shape storage", () => {
  it("keys the shape by environment and project root", () => {
    expect(projectTreeKey(ENV, CWD)).toBe(`env-1:${CWD}`);
    expect(treeShapeStorageKey(ENV, CWD)).toBe(`mesura.fileTree.env-1:${CWD}`);
  });

  it("round-trips the selected path and the collapsed folders through the JSON codec", () => {
    const shape = shapeOf(`${CWD}/src/main.ts`, [`${CWD}/node_modules`, `${CWD}/dist`]);
    const json = encodeJson(encodeTreeShape(shape));
    expect(typeof json).toBe("string");
    const restored = decodeStoredTreeShape(decodeJson(json));
    expect(restored?.selected).toBe(shape.selected);
    expect([...(restored?.collapsed ?? [])]).toEqual([...shape.collapsed].sort());
  });

  it("yields null for a value that fails the schema, without throwing", () => {
    expect(decodeStoredTreeShape(null)).toBeNull();
    expect(decodeStoredTreeShape("junk")).toBeNull();
    expect(decodeStoredTreeShape({ selected: 3, collapsed: [] })).toBeNull();
    expect(decodeStoredTreeShape({ selected: CWD, collapsed: [1] })).toBeNull();
  });

  it("restores a full tree shape and does not rewrite the shape it just read", () => {
    const memory = memoryStorage();
    memory.seed(treeShapeStorageKey(ENV, CWD), {
      selected: `${CWD}/src`,
      collapsed: [`${CWD}/dist`, `${CWD}/build`],
    });
    const persister = createTreeShapePersister(memory.storage, 0);
    const shape = persister.restore(ENV, CWD);
    expect(shape).toEqual(shapeOf(`${CWD}/src`, [`${CWD}/build`, `${CWD}/dist`]));
    expect(persister.restore(ENV, "/elsewhere")).toBeNull();
    if (shape === null) throw new Error("restored nothing");
    persister.persist(ENV, CWD, shape);
    persister.flush();
    expect(memory.writes).toEqual([]);
    persister.persist(ENV, CWD, shapeOf(`${CWD}/src`, [`${CWD}/dist`]));
    persister.flush();
    expect(memory.writes).toHaveLength(1);
  });

  it("writes on a content change and not on an equal shape", () => {
    const memory = memoryStorage();
    const persister = createTreeShapePersister(memory.storage, 0);
    const key = treeShapeStorageKey(ENV, CWD);
    persister.persist(ENV, CWD, shapeOf(CWD, [`${CWD}/dist`]));
    persister.persist(ENV, CWD, { ...shapeOf(CWD, [`${CWD}/dist`]), checkpoint: new Set() });
    persister.flush();
    expect(memory.writes.map(([k]) => k)).toEqual([key]);
    persister.persist(ENV, CWD, shapeOf(CWD, []));
    persister.flush();
    expect(memory.writes).toHaveLength(2);
    expect(memory.writes[1]?.[1]).toEqual({ selected: CWD, collapsed: [] });
  });

  it("coalesces a burst of changes into the last one", () => {
    const memory = memoryStorage();
    const persister = createTreeShapePersister(memory.storage, 0);
    persister.persist(ENV, CWD, shapeOf(`${CWD}/a`, []));
    persister.persist(ENV, CWD, shapeOf(`${CWD}/b`, []));
    persister.persist(ENV, CWD, shapeOf(`${CWD}/c`, []));
    persister.flush();
    expect(memory.writes).toHaveLength(1);
    expect(memory.writes[0]?.[1]).toEqual({ selected: `${CWD}/c`, collapsed: [] });
  });

  it("stores nothing for a project whose shape is still the default", () => {
    const memory = memoryStorage();
    const persister = createTreeShapePersister(memory.storage, 0);
    persister.persist(ENV, CWD, shapeOf(CWD, []));
    persister.flush();
    expect(memory.writes).toEqual([]);
    persister.persist(ENV, CWD, shapeOf(CWD, [`${CWD}/dist`]));
    persister.flush();
    expect(memory.writes).toHaveLength(1);
  });

  it("retries after a write that did not land", () => {
    const memory = memoryStorage({ failWrites: true });
    const persister = createTreeShapePersister(memory.storage, 0);
    persister.persist(ENV, CWD, shapeOf(CWD, [`${CWD}/dist`]));
    persister.flush();
    expect(memory.writes).toEqual([]);
    memory.setFailWrites(false);
    persister.persist(ENV, CWD, shapeOf(CWD, [`${CWD}/dist`]));
    persister.flush();
    expect(memory.writes).toHaveLength(1);
  });
});
