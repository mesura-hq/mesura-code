import type { TreeShape } from "@symmetria/fm-ui/tree";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { createSchemaLocalStorage } from "./schemaLocalStorage";
import { createWriteCoalescer, flushOnPageHide } from "./writeCoalescer";

/**
 * The tree's cursor and collapsed folders, per project; `preset` and `checkpoint` stay
 * session state. Root and restored shape must reach the tree together, so the record is
 * built from this before the tree mounts. Keys are never evicted (known limitation).
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
 * Restores and persists a project's shape. Every cursor move reports a change, so writes
 * are coalesced and flushed on page hide. A shape equal to the last successful write, or
 * the default shape of a project that stored nothing, is not written.
 */
export function createTreeShapePersister(storage: TreeShapeStorage, wait = WRITE_DELAY_MS) {
  const written = new Map<string, StoredTreeShape>();
  const pending = new Map<string, StoredTreeShape>();

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
  const writer = createWriteCoalescer(() => {
    for (const [key, value] of pending) {
      if (storage.write(key, value)) remember(key, value);
    }
    pending.clear();
  }, wait);

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
      writer.schedule();
    },
    flush: writer.flush,
  };
}

const localTreeShapeStorage = createSchemaLocalStorage(StoredTreeShape, "FILE-TREE");

export const treeShapePersister = createTreeShapePersister(localTreeShapeStorage);
flushOnPageHide(treeShapePersister);
