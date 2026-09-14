import type { OverviewViewState } from "@symmetria/fm-ui/overview";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { createSchemaLocalStorage } from "./schemaLocalStorage";
import { projectTreeKey } from "./treeShapeStorage";
import { createWriteCoalescer, flushOnPageHide } from "./writeCoalescer";

/**
 * The overview's view, persisted per graph root: the selection, the collapsed
 * groups, the camera, and the box layout the graph measured. The boxes are a
 * layout cache keyed by path; stored, they keep the graph where it was across
 * a reload instead of re-flowing from scratch. A stale box for a folder that
 * no longer exists is ignored by the graph.
 */
const Point = Schema.Struct({ x: Schema.Number, y: Schema.Number });
const Box = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
export const StoredOverviewView = Schema.Struct({
  selected: Schema.String,
  collapsed: Schema.Array(Schema.String),
  zoom: Schema.Number,
  origin: Point,
  scroll: Point,
  boxes: Schema.Array(Schema.Tuple([Schema.String, Box])),
});
export type StoredOverviewView = typeof StoredOverviewView.Type;

export function overviewViewStorageKey(environmentId: EnvironmentId, root: string): string {
  return `mesura.fileTreeOverview.${projectTreeKey(environmentId, root)}`;
}

const isStoredOverviewView = Schema.is(StoredOverviewView);

/** A stored value that fails the schema is forgotten, never thrown. */
export function decodeStoredOverviewView(value: unknown): StoredOverviewView | null {
  return isStoredOverviewView(value) ? value : null;
}

export interface OverviewViewStorage {
  read(key: string): StoredOverviewView | null;
  write(key: string, value: StoredOverviewView): boolean;
}

const WRITE_DELAY_MS = 300;

/**
 * Loads and saves the view per graph root. The graph saves on every scroll
 * frame and on every render, so saves are coalesced; nothing reads the stored
 * value while the graph is up, and the latest save is the one that counts.
 */
export function createOverviewViewStore(storage: OverviewViewStorage, wait = WRITE_DELAY_MS) {
  let pending: { key: string; view: StoredOverviewView } | null = null;
  const writer = createWriteCoalescer(() => {
    if (pending !== null) storage.write(pending.key, pending.view);
    pending = null;
  }, wait);
  return {
    load(environmentId: EnvironmentId, root: string): OverviewViewState | null {
      const stored = storage.read(overviewViewStorageKey(environmentId, root));
      if (stored === null) return null;
      return {
        selected: stored.selected,
        collapsed: new Set(stored.collapsed),
        zoom: stored.zoom,
        origin: stored.origin,
        scroll: stored.scroll,
        boxes: new Map(stored.boxes),
      };
    },
    save(environmentId: EnvironmentId, root: string, view: OverviewViewState): void {
      pending = {
        key: overviewViewStorageKey(environmentId, root),
        view: {
          selected: view.selected,
          collapsed: [...view.collapsed],
          zoom: view.zoom,
          origin: { x: view.origin.x, y: view.origin.y },
          scroll: { x: view.scroll.x, y: view.scroll.y },
          boxes: [...view.boxes].map(([path, box]) => [
            path,
            { x: box.x, y: box.y, width: box.width, height: box.height },
          ]),
        },
      };
      writer.schedule();
    },
    flush: writer.flush,
  };
}

export const overviewViewStore = createOverviewViewStore(
  createSchemaLocalStorage(StoredOverviewView, "FILE-TREE"),
);
flushOnPageHide(overviewViewStore);
