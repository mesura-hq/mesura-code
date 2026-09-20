import type { CursorEntry, KeyContext } from "@symmetria/fm-core/keys/types";
import { isAncestorPath } from "@symmetria/fm-core/overview/model";
import { cursorEntry, joinPath } from "@symmetria/fm-core/pane";
import { useCallback, useEffect, useRef, useState } from "react";
import { type FlashPort, useFlashPort } from "../flash/useFlashPort.ts";
import type { OverviewModel } from "../overview/useOverview.ts";
import type { Tabs } from "../useTabs.ts";
import { type TreeRecord, TreeStateCache } from "./state.ts";

export type TreeCommand =
  | "search"
  | "search-next"
  | "search-previous"
  | "flash"
  | "down"
  | "up"
  | "left"
  | "right"
  | "activate"
  | "toggle"
  | "first"
  | "last"
  | "half-down"
  | "half-up"
  | "page-down"
  | "page-up";
export interface TreeController {
  command(command: TreeCommand): void;
  reveal(path: string): void;
  cancel(): void;
}
export interface TreePort {
  flash?: FlashPort;
  search?(state: { active: boolean; count: number }): void;
  connect(handler: TreeController): () => void;
  select(entry: CursorEntry): void;
}
interface TreeTab {
  root: string;
  active: boolean;
  generation: number;
}

export function useTreeMode(tabs: Tabs) {
  const flash = useFlashPort();
  const [search, setSearch] = useState({ active: false, count: 0 });
  const id = tabs.views[tabs.activeIndex]?.id ?? "";
  const [views, setViews] = useState<ReadonlyMap<string, TreeTab>>(new Map());
  const [cache] = useState(() => new TreeStateCache());
  const tab = views.get(id);
  const root = tab?.active ? tab.root : null;
  const [entry, setEntry] = useState<CursorEntry | null>(null);
  const handler = useRef<TreeController | null>(null);
  const connect = useCallback((next: TreeController) => {
    handler.current = next;
    return () => {
      if (handler.current === next) handler.current = null;
    };
  }, []);
  const ids = tabs.views.map((view) => view.id).join("\0");
  useEffect(() => {
    const alive = ids.split("\0");
    cache.retain(alive);
    setViews((previous) => new Map([...previous].filter(([key]) => alive.includes(key))));
  }, [ids, cache]);
  const change = (key: string, value: TreeTab) =>
    setViews((previous) => new Map(previous).set(key, value));
  const close = () => {
    handler.current?.cancel();
    if (tab) change(id, { ...tab, active: false });
  };
  const open = () => {
    if (root !== null) return;
    const returning = tab?.generation === tabs.navigationGeneration();
    const nextRoot = returning ? tab.root : tabs.pane.path;
    if (!returning) prepareTreeReturn(tabs, cache.get(id, nextRoot, tabs.showHidden), nextRoot);
    change(id, { root: nextRoot, active: true, generation: tabs.navigationGeneration() });
  };
  const external = (path: string) => {
    const target = tabs.views.find((view) => view.path === path);
    if (target)
      setViews((previous) => {
        const next = new Map(previous);
        const existing = next.get(target.id);
        if (existing) next.set(target.id, { ...existing, active: false });
        return next;
      });
    tabs.openAt(path);
  };
  return {
    root,
    search,
    flashActive: root !== null && flash.active,
    onFlashKey: flash.onKey,
    entry,
    id,
    key: JSON.stringify([id, root, tabs.showHidden]),
    record: root === null ? null : cache.get(id, root, tabs.showHidden),
    port: { connect, select: setEntry, flash: flash.port, search: setSearch } satisfies TreePort,
    newTab: () => tabs.open(root ?? tabs.pane.path),
    toggleHidden: tabs.toggleHidden,
    close,
    open,
    external,
    reveal: (path: string) => handler.current?.reveal(path),
    cancel: () => handler.current?.cancel(),
    command: (command: TreeCommand) => handler.current?.command(command),
  };
}

export function treeKeyContext(
  context: KeyContext,
  tree: ReturnType<typeof useTreeMode>,
  model: OverviewModel,
): KeyContext {
  if (tree.root === null || context.view === "overview") return context;
  return {
    ...context,
    view: "tree",
    tree: { close: tree.close },
    state: {
      ...context.state,
      cursorEntry: tree.entry,
      selectedCount: 0,
      searchActive: tree.search.active,
      matchCount: tree.search.count,
    },
    actions: {
      ...context.actions,
      startSearch: () => tree.command("search"),
      nextMatch: () => tree.command("search-next"),
      previousMatch: () => tree.command("search-previous"),
      startFlash: () => tree.command("flash"),
      tabNew: tree.newTab,
      treeToggleHidden: tree.toggleHidden,
      treeRefresh: () => model.refresh?.(),
      moveDown: () => tree.command("down"),
      moveUp: () => tree.command("up"),
      activate: () => tree.command("activate"),
      jumpToTop: () => tree.command("first"),
      jumpToBottom: () => tree.command("last"),
      halfPageDown: () => tree.command("half-down"),
      halfPageUp: () => tree.command("half-up"),
      treePageDown: () => tree.command("page-down"),
      treePageUp: () => tree.command("page-up"),
      treeCollapseOrParent: () => tree.command("left"),
      treeExpandOrActivate: () => tree.command("right"),
      treeToggleExpand: () => tree.command("toggle"),
    },
  };
}

function prepareTreeReturn(tabs: Tabs, record: TreeRecord, root: string) {
  const selected = cursorEntry(tabs.pane);
  const path =
    tabs.pendingRevealPath() ??
    (selected ? joinPath(tabs.pane.path, selected.name) : record.shape.selected);
  if (isAncestorPath(root, path)) record.pendingReveal = path;
}
