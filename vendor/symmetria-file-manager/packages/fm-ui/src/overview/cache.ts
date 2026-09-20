import type { Box } from "@symmetria/fm-core/overview/layout";
import type { Point } from "@symmetria/fm-core/overview/viewport";
import { type OverviewSnapshot, representedEntries } from "./session.ts";
export interface OverviewViewState {
  readonly selected: string;
  readonly collapsed: ReadonlySet<string>;
  readonly zoom: number;
  readonly origin: Point;
  readonly scroll: Point;
  readonly boxes: ReadonlyMap<string, Box>;
}
interface CachedOverview {
  snapshot: OverviewSnapshot;
  view?: OverviewViewState | undefined;
}
/** One renderer owns this cache; no subscriptions or pending work enter it. */
export class OverviewCache {
  private roots = new Map<string, OverviewSnapshot>();
  private views = new Map<string, OverviewViewState>();
  get size(): number {
    return this.roots.size;
  }
  get entries(): number {
    return [...this.roots.values()].reduce(
      (count, item) => count + representedEntries(item.folders),
      0,
    );
  }
  get(key: string): CachedOverview | undefined {
    const snapshot = this.roots.get(key);
    return snapshot ? { snapshot, view: this.views.get(key) } : undefined;
  }
  save(key: string, snapshot: OverviewSnapshot): void {
    this.roots.delete(key);
    this.roots.set(key, snapshot);
    while (this.roots.size > 3 || this.entries > 15000) {
      const oldest = this.roots.keys().next().value;
      if (oldest === undefined) break;
      this.roots.delete(oldest);
      this.views.delete(oldest);
    }
  }
  saveView(key: string, view: OverviewViewState): void {
    if (this.roots.has(key)) this.views.set(key, view);
  }
}
