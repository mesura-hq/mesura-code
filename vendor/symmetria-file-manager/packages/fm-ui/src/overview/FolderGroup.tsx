import type { GraphGroup, Measurement } from "@symmetria/fm-core/overview/layout";
import { basename } from "@symmetria/fm-core/overview/model";
import { joinPath, parentOf } from "@symmetria/fm-core/pane";
import { FileIcon } from "@symmetria/fm-search/ui";
import { useLayoutEffect, useRef } from "react";
export function FolderGroup({
  group,
  selected,
  matches,
  collapsed,
  onSelect,
  onToggle,
  onMeasure,
  onInclude,
}: {
  readonly group: GraphGroup;
  readonly selected: string;
  readonly matches?: ReadonlySet<string>;
  readonly collapsed: boolean;
  readonly onSelect: (path: string) => void;
  readonly onToggle: (path: string) => void;
  readonly onMeasure: (path: string, size: Measurement) => void;
  readonly onInclude: (path: string) => void;
}) {
  const element = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const measure = () => {
      if (node.offsetHeight > 0)
        onMeasure(group.path, { width: node.offsetWidth, height: node.offsetHeight });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [group.path, onMeasure]);
  return (
    <section
      ref={element}
      className="folder-group"
      data-group={group.path}
      data-x={group.x}
      data-y={group.y}
      style={{ left: group.x, top: group.y, width: group.width }}
    >
      <header>
        <button
          type="button"
          className="folder-group-name"
          data-basename
          data-selected={selected === group.path}
          data-search-match={matches?.has(group.path) ?? false}
          onClick={() => onSelect(group.path)}
        >
          <FileIcon name={basename(group.path)} kind="directory" />
          <span className="overview-name">{basename(group.path)}</span>
        </button>
        <button
          type="button"
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${basename(group.path)}`}
          onClick={() => onToggle(group.path)}
        >
          {collapsed ? "+" : "−"}
        </button>
      </header>
      <div className="folder-ancestors" dir="rtl">
        {parentOf(group.path)}
      </div>
      <div
        className="folder-entries"
        style={{ gridTemplateColumns: `repeat(${group.columns},240px)` }}
      >
        {Array.from({ length: group.columns }, (_, column) => (
          <div key={group.entries[column * 12]?.name ?? group.path}>
            {group.entries.slice(column * 12, column * 12 + 12).map((entry) => (
              <button
                type="button"
                className="overview-row"
                data-entry={joinPath(group.path, entry.name)}
                data-selected={selected === joinPath(group.path, entry.name)}
                data-search-match={matches?.has(joinPath(group.path, entry.name)) ?? false}
                key={entry.name}
                onClick={() => onSelect(joinPath(group.path, entry.name))}
              >
                <FileIcon name={entry.name} kind={entry.kind} />
                {entry.isSymlink ? <span aria-hidden="true">↗</span> : null}
                <span className="overview-name">{entry.name}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
      {group.status === "Loaded" ? (
        group.entries.length === 0 ? (
          <p className="folder-status">Empty folder</p>
        ) : null
      ) : (
        <p className="folder-status">{group.status}</p>
      )}
      {group.status === "Excluded by scope" ||
      group.status === "Depth limit reached" ||
      group.status === "Not loaded" ? (
        <button type="button" className="folder-load" onClick={() => onInclude(group.path)}>
          Load this folder
        </button>
      ) : null}
    </section>
  );
}
