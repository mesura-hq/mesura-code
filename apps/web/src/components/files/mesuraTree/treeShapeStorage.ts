import type { TreeShape } from "@symmetria/fm-ui/tree";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { createSchemaLocalStorage } from "./schemaLocalStorage";

/**
 * The tree's shape, persisted per project.
 *
 * Stored are the cursor and the collapsed folders — the file manager's tree is
 * expanded by default and its shape stores what is collapsed. `preset` and
 * `checkpoint` back the toolbar's expand-all / restore and are session state.
 * The Symmetria IDE persisted the same thing host-side and learned that root
 * and restored shape must reach the tree together; here the record is built
 * from the stored shape before the tree mounts, so that holds by construction.
 *
 * Keys are never removed: a project the developer stops opening keeps its
 * shape in the origin's storage. Known limitation; a timestamp and an
 * eviction pass would fix it when the count ever matters.
 */
export const StoredTreeShape = Schema.Struct({
  selected: Schema.String,
  collapsed: Schema.Array(Schema.String),
});
export type StoredTreeShape = typeof StoredTreeShape.Type;

/** One identity for a project's tree: the record, the DOM hook and the storage key share it. */
export function projectTreeKey(environmentId: EnvironmentId, cwd: string): string {
  return `${environmentId}:${cwd}`;
}

export function treeShapeStorageKey(environmentId: EnvironmentId, cwd: string): string {
  return `mesura.fileTree.${projectTreeKey(environmentId, cwd)}`;
}

export function encodeTreeShape(shape: TreeShape): StoredTreeShape {
  return { selected: shape.selected, collapsed: [...shape.collapsed].sort() };
}

/**
 * A stored value that fails the schema is forgotten, never thrown. The real
 * storage decodes against the schema when it parses the JSON; this check is
 * what keeps the `TreeShapeStorage` seam safe for any implementation that
 * hands back raw values. Keep both.
 */
const isStoredTreeShape = Schema.is(StoredTreeShape);

export function decodeStoredTreeShape(value: unknown): StoredTreeShape | null {
  return isStoredTreeShape(value) ? value : null;
}

export interface TreeShapeStorage {
  read(key: string): unknown;
  /** True when the value landed; a false write is retried by the next change. */
  write(key: string, value: StoredTreeShape): boolean;
}

const WRITE_DELAY_MS = 300;
const REMEMBERED_KEYS = 16;

/**
 * Restores a project's shape and persists changes to it.
 *
 * `selected` is part of the shape, so the library reports a change on every
 * cursor move; writes are coalesced behind a short delay and flushed when the
 * page hides, so holding `j` costs no synchronous storage write per key. A
 * shape equal to the last successful write, or the default shape of a project
 * that stored nothing, is not written.
 */
export function createTreeShapePersister(storage: TreeShapeStorage, wait = WRITE_DELAY_MS) {
  const written = new Map<string, StoredTreeShape>();
  const pending = new Map<string, StoredTreeShape>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const remember = (key: string, value: StoredTreeShape) => {
    written.delete(key);
    written.set(key, value);
    while (written.size > REMEMBERED_KEYS) {
      const oldest = written.keys().next().value;
      if (oldest === undefined) break;
      written.delete(oldest);
    }
  };
  const same = (a: StoredTreeShape, b: StoredTreeShape) =>
    a.selected === b.selected &&
    a.collapsed.length === b.collapsed.length &&
    a.collapsed.every((path, index) => path === b.collapsed[index]);
  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    for (const [key, value] of pending) {
      if (storage.write(key, value)) remember(key, value);
    }
    pending.clear();
  };

  return {
    restore(environmentId: EnvironmentId, cwd: string): TreeShape | null {
      const key = treeShapeStorageKey(environmentId, cwd);
      const stored = decodeStoredTreeShape(storage.read(key));
      if (stored === null) return null;
      // The restored value is the baseline for the write comparison: the tree
      // reports its mount shape at once, and it equals what was just read, in
      // the normalised (sorted) form the comparison uses.
      const baseline = { selected: stored.selected, collapsed: [...stored.collapsed].sort() };
      remember(key, baseline);
      return {
        selected: baseline.selected,
        collapsed: new Set(baseline.collapsed),
        preset: null,
        checkpoint: null,
      };
    },
    persist(environmentId: EnvironmentId, cwd: string, shape: TreeShape): void {
      const key = treeShapeStorageKey(environmentId, cwd);
      const next = encodeTreeShape(shape);
      const last = pending.get(key) ?? written.get(key);
      if (last !== undefined && same(last, next)) return;
      // A project that stored nothing gets no key for merely being opened.
      if (last === undefined && next.collapsed.length === 0 && next.selected === cwd) return;
      pending.set(key, next);
      if (timer === null) timer = setTimeout(flush, wait);
    },
    flush,
  };
}

const localTreeShapeStorage = createSchemaLocalStorage(StoredTreeShape, "FILE-TREE");

export const treeShapePersister = createTreeShapePersister(localTreeShapeStorage);

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => treeShapePersister.flush());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") treeShapePersister.flush();
  });
}
