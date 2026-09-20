import { FileIcon } from "@symmetria/fm-search/ui";
import { isTreeDirectory, type TreeRow as TreeRowModel, treeItemId } from "./model.ts";

export function TreeRow({
  row,
  selected,
  matched = false,
  top,
  select,
  activate,
  toggle,
  include,
}: {
  row: TreeRowModel;
  selected: boolean;
  matched?: boolean;
  top: number;
  select(): void;
  activate(): void;
  toggle(): void;
  include(): void;
}) {
  const directory = isTreeDirectory(row);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the tree container owns focus and the shared window dispatcher handles keyboard activation.
    <div
      role="treeitem"
      id={treeItemId(row.path)}
      tabIndex={-1}
      aria-label={row.name}
      aria-level={row.depth + 1}
      aria-posinset={row.position}
      aria-setsize={row.siblings}
      aria-expanded={directory ? row.expanded : undefined}
      aria-selected={selected}
      data-path={row.path}
      data-search-match={matched}
      data-coverage={row.status}
      className="tree-row"
      style={{ top, paddingLeft: 10 + row.depth * 14 }}
      onClick={select}
      onDoubleClick={activate}
    >
      <span aria-hidden="true" className="tree-guides" style={{ width: row.depth * 14 }} />
      {directory ? (
        <button
          type="button"
          tabIndex={-1}
          className="tree-disclosure"
          aria-label={`${row.expanded ? "Collapse" : "Expand"} ${row.name}`}
          onClick={(event) => {
            event.stopPropagation();
            select();
            toggle();
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {row.expanded ? "⌄" : "›"}
        </button>
      ) : (
        <span className="tree-disclosure" />
      )}
      <FileIcon name={row.name} kind={row.kind} />
      <span className="tree-name">{row.name}</span>
      <TreeCoverage row={row} include={include} />
    </div>
  );
}

function TreeCoverage({ row, include }: { row: TreeRowModel; include(): void }) {
  const directory = isTreeDirectory(row);
  const pending = row.status === "Loading" || row.status === "Queued";
  return (
    <>
      {row.isSymlink ? <span className="tree-coverage">↗ link</span> : null}
      {row.status !== "Loaded" ? <span className="tree-coverage">{row.status}</span> : null}
      {directory && row.status !== "Loaded" && !pending ? (
        <button
          type="button"
          className="tree-include"
          aria-label={`Include ${row.name}`}
          onClick={(event) => {
            event.stopPropagation();
            include();
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {row.status.startsWith("Unreadable") ? "Retry" : "Include"}
        </button>
      ) : null}
    </>
  );
}
