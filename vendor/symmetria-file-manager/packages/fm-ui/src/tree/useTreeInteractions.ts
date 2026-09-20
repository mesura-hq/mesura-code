import { useRef } from "react";
import { useViewportFlash } from "../flash/useViewportFlash.ts";
import type { FlashSceneAdapter } from "../overview/flashTargets.ts";
import type { OverviewModel } from "../overview/useOverview.ts";
import type { TreeRecord } from "./state.ts";
import type { TreePort } from "./useTreeMode.ts";
import { useTreeSearch } from "./useTreeSearch.ts";
import type { useTreeState } from "./useTreeState.ts";

const TREE_SCENE: FlashSceneAdapter = {
  owner: (viewport) => viewport.closest(".file-tree"),
  focus: (viewport) => viewport,
  targets: "[data-path]",
  name: ".tree-name",
  occluders: ".tree-toolbar, .tree-expansion-menu, .overview-popover, .overview-search",
  path: (element) => element.dataset.path,
};
export function useTreeInteractions(
  root: string,
  model: OverviewModel,
  state: ReturnType<typeof useTreeState>,
  record: TreeRecord,
  viewport: HTMLDivElement | null,
  port: TreePort,
  cancel: () => void,
) {
  const ref = useRef(viewport);
  ref.current = viewport;
  const search = useTreeSearch(root, model, state, record, viewport);
  const flash = useViewportFlash({
    viewport: ref,
    generation: JSON.stringify(state.rows.map((row) => [row.path, row.expanded, row.status])),
    port,
    adapter: TREE_SCENE,
    stopCamera: cancel,
    select: state.select,
  });
  return {
    search,
    flash,
    reset: () => {
      cancel();
      flash.cancel();
      search.clear();
    },
  };
}
