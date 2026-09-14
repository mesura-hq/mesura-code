/**
 * The finder's panel half, as a host sees it.
 *
 * DOM only. Nothing under `src/ui` may import a Node module or the file
 * manager's panel package — that is what lets a host mount the finder alone,
 * and an invariant test proves it rather than a convention asking for it.
 */

export {
  recordSearchOpen,
  releaseSearchIndex,
  searchIn,
  startSearchIndex,
} from "./bridge.ts";
export { FileIcon, type FileIconProps } from "./FileIcon.tsx";
export { FinderInfoPanel, type RenderPreview } from "./FinderInfoPanel.tsx";
export { FinderOverlay, type FinderOverlayProps } from "./FinderOverlay.tsx";
export { type Finder, SEARCH_DEBOUNCE_MS, useFinder } from "./useFinder.ts";
export { type OverlayList, useOverlayList } from "./useOverlayList.ts";
