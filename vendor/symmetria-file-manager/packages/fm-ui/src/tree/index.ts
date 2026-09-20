/**
 * The tree, as a host sees it.
 *
 * A host mounts `FileTree` alone — without the panel, the Miller view or the
 * scanner — and drives it through `TreePort`. Everything a host may touch is
 * named here; the rest of `src/tree` is private to the panel.
 */

export { useFlashPort } from "../flash/useFlashPort.ts";
export type { OverviewModel } from "../overview/useOverview.ts";
export { FileTree } from "./FileTree.tsx";
export type { TreeAnchor, TreeRecord, TreeShape } from "./state.ts";
export type { TreeCommand, TreeController, TreePort } from "./useTreeMode.ts";
