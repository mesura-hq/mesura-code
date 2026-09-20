import type { OverviewModel } from "../overview/useOverview.ts";
import { FileTree } from "../tree/FileTree.tsx";
import type { useTreeMode } from "../tree/useTreeMode.ts";
import type { Tabs } from "../useTabs.ts";
import { MillerColumns, type MillerColumnsProps } from "./MillerColumns.tsx";
import { PathBar } from "./PathBar.tsx";

export function BrowsingView({
  tabs,
  tree,
  model,
  onOpen,
  matches,
  preview,
  flashLabels,
  flashActive,
  onVisibleRange,
  onActivate,
  onLeaveTo,
}: {
  tabs: Tabs;
  tree: ReturnType<typeof useTreeMode>;
  model: OverviewModel;
  onOpen(path: string): void;
  matches: ReadonlySet<number>;
  preview: NonNullable<MillerColumnsProps["preview"]>;
  flashLabels: NonNullable<MillerColumnsProps["flashLabels"]>;
  flashActive: boolean;
  onVisibleRange: NonNullable<MillerColumnsProps["onVisibleRange"]>;
  onActivate(index: number): void;
  onLeaveTo(name: string): void;
}) {
  if (tree.root !== null && tree.record !== null)
    return (
      <FileTree
        key={tree.key}
        root={tree.root}
        record={tree.record}
        model={model}
        port={tree.port}
        onOpen={onOpen}
        onMiller={tree.close}
      />
    );
  return (
    <>
      <div className="view-control">
        <PathBar path={tabs.pane.path} onNavigate={tabs.navigate} />
      </div>
      <MillerColumns
        path={tabs.pane.path}
        parentEntries={tabs.parentEntries}
        entries={tabs.pane.entries}
        cursorIndex={tabs.pane.cursorIndex}
        parentCursorName={tabs.parentCursorName}
        selection={tabs.pane.selection}
        matches={matches}
        onSelect={tabs.moveTo}
        onActivate={onActivate}
        onLeaveTo={onLeaveTo}
        preview={preview}
        flashLabels={flashLabels}
        flashActive={flashActive}
        onVisibleRange={onVisibleRange}
      />
    </>
  );
}
