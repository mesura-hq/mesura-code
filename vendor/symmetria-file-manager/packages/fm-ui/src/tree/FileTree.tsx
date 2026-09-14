import { defaultRangeExtractor, type Range, useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useId, useState } from "react";
import { PathBar } from "../components/PathBar.tsx";
import { INITIAL_RECT, observeWithFallback } from "../components/virtualize.ts";
import { ViewportFlash } from "../flash/ViewportFlash.tsx";
import type { OverviewModel } from "../overview/useOverview.ts";
import { LoadedPathSearch } from "../search/LoadedPathSearch.tsx";
import { isTreeDirectory, treeItemId } from "./model.ts";
import { runTreeCommand } from "./navigation.ts";
import type { TreeRecord } from "./state.ts";
import { TreeRow } from "./TreeRow.tsx";
import { TreeToolbar } from "./TreeToolbar.tsx";
import { useTreeController } from "./useTreeController.ts";
import { useTreeInteractions } from "./useTreeInteractions.ts";
import type { TreeCommand, TreePort } from "./useTreeMode.ts";
import { useTreeNavigation } from "./useTreeNavigation.ts";
import { useTreeReveal } from "./useTreeReveal.ts";
import { useTreeState } from "./useTreeState.ts";
import { useTreeWidth } from "./useTreeWidth.ts";
import "./tree.css";

const ROW_HEIGHT = 24;

export function FileTree({
  root,
  model,
  port,
  onOpen,
  onMiller,
  record,
}: {
  root: string;
  model: OverviewModel;
  port: TreePort;
  onOpen(path: string): void;
  onMiller(): void;
  record: TreeRecord;
}) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const labelId = useId();
  const state = useTreeState(root, model, record);
  const { rows, select: setSelected, toggle } = state;
  const selected = state.shape.selected;
  const cursor = Math.max(
    0,
    rows.findIndex((row) => row.path === selected),
  );
  const current = rows[cursor];
  const rangeExtractor = useCallback(
    (range: Range) => {
      const shown = defaultRangeExtractor(range);
      return shown.includes(cursor) ? shown : [...shown, cursor].sort((a, b) => a - b);
    },
    [cursor],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewport,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    initialRect: INITIAL_RECT,
    observeElementRect: observeWithFallback,
    rangeExtractor,
    getItemKey: (index) => rows[index]?.path ?? index,
  });
  // The virtualizer initializes native scroll during its layout effect. Restoring
  // before that effect reset both saved anchors and initial reveals to zero.
  const resolvingReveal = useTreeReveal(record.pendingReveal, model);
  const motion = useTreeNavigation(
    viewport,
    rows,
    selected,
    record,
    model.loading || resolvingReveal,
    setSelected,
  );
  const activate = (index: number) => {
    const row = rows[index];
    if (!row) return;
    motion.cancel();
    setSelected(row.path);
    if (isTreeDirectory(row)) toggle(row.path);
    else onOpen(row.path);
  };
  const { search, flash, reset } = useTreeInteractions(
    root,
    model,
    state,
    record,
    viewport,
    port,
    motion.cancel,
  );
  const interrupt = () => {
    record.pendingReveal = null;
    motion.cancel();
  };
  const command = (name: TreeCommand) => {
    record.pendingReveal = null;
    if (name === "search") {
      motion.cancel();
      search.open();
      return;
    }
    if (name === "search-next") {
      motion.cancel();
      search.goNext();
      return;
    }
    if (name === "search-previous") {
      motion.cancel();
      search.goPrevious();
      return;
    }
    if (name === "flash") {
      flash.open();
      return;
    }
    runTreeCommand(name, rows, cursor, {
      select: setSelected,
      toggle,
      activate,
      page: motion.page,
      jump: motion.jump,
      cancel: motion.cancel,
    });
  };
  useTreeController(
    port,
    { command, reveal: state.reveal, cancel: reset },
    current,
    search.active,
    search.matchCount,
    viewport,
  );
  const width = useTreeWidth(rows, viewport);
  return (
    <section className="file-tree" aria-label="Project file tree">
      <TreeToolbar
        model={model}
        labelId={labelId}
        onMiller={onMiller}
        preset={(value) => {
          interrupt();
          reset();
          state.preset(value);
        }}
        canRestore={state.shape.checkpoint !== null}
      />
      <div className="tree-breadcrumb" title={selected}>
        <PathBar path={selected} />
      </div>
      <div
        className="tree-search"
        data-flash-hidden={flash.active}
        aria-hidden={flash.active}
        inert={flash.active}
      >
        <LoadedPathSearch search={search} />
      </div>
      <div className="tree-frame" data-flash-mode={flash.active}>
        <div
          ref={setViewport}
          className="tree-viewport"
          role="tree"
          aria-labelledby={labelId}
          tabIndex={0}
          aria-activedescendant={current ? treeItemId(current.path) : undefined}
          data-root={root}
          data-row-count={rows.length}
          onScroll={motion.onScroll}
          onWheel={interrupt}
          onPointerDown={interrupt}
        >
          <div
            className="tree-canvas"
            style={{ height: virtualizer.getTotalSize(), minWidth: width }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              return row ? (
                <TreeRow
                  key={row.path}
                  row={row}
                  selected={row.path === current?.path}
                  matched={
                    flash.active ? flash.matches.has(row.path) : search.matches.has(row.path)
                  }
                  top={item.start}
                  select={() => {
                    motion.cancel();
                    setSelected(row.path);
                    viewport?.focus({ preventScroll: true });
                  }}
                  activate={() => activate(item.index)}
                  toggle={() => {
                    interrupt();
                    toggle(row.path);
                  }}
                  include={() => model.include(row.path)}
                />
              ) : null;
            })}
          </div>
        </div>
        <ViewportFlash flash={flash} />
      </div>
    </section>
  );
}
