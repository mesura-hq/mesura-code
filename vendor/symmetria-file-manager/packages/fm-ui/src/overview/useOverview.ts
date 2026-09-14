import { useDirectorySnapshot } from "../directory/useDirectorySnapshot.ts";
import type { OverviewViewState } from "./cache.ts";
import type { OverviewSnapshot } from "./session.ts";
export interface OverviewModel extends OverviewSnapshot {
  readonly automaticDepth?: number;
  include(path: string): void;
  readonly view?: OverviewViewState | undefined;
  saveView?(view: OverviewViewState): void;
  refresh?(): void;
  readonly refreshing?: boolean;
  readonly paused?: boolean;
}
export function useOverview(
  root: string | null,
  showHidden: boolean,
  automaticDepth?: number,
): OverviewModel {
  const { cache, key, ...snapshot } = useDirectorySnapshot(root, showHidden, automaticDepth);
  return { ...snapshot, view: cache.get(key)?.view, saveView: (view) => cache.saveView(key, view) };
}
