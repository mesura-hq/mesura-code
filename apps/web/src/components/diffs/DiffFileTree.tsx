import type { FileTreeRowDecoration, GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree, useFileTreeSelector } from "@pierre/trees/react";
import { ChevronsDownUp, ChevronsUpDown } from "lucide";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { PIERRE_TREE_UNSAFE_CSS, pierreTreeStyle } from "~/pierre-tree-theme";

import { areAllDirectoriesExpanded, setAllDirectoriesExpanded } from "../files/fileTreeExpansion";
import { Button } from "../ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildDiffFileTreeUpdates,
  compareDiffFileTreeEntries,
  collectDirectoryPaths,
  diffFileTreeModel,
  diffFileTreePositions,
  type DiffFileTreeEntry,
} from "./diffFileTree.logic";
import { usePierreTreePaneEntry } from "./pierreTreeKeys";

export type { DiffFileTreeEntry } from "./diffFileTree.logic";

/**
 * Fork addition: Symmetria IDE's git palette instead of Pierre's, whose blue
 * for a modified file is the same blue as an untracked one and as the app's
 * links. Modified is amber, so blue is left to untracked alone. The values are
 * the app's own tokens, so both themes follow. Custom properties inherit into
 * Pierre's shadow root, where its `--trees-git-*-color-override` hooks read them.
 */
const GIT_STATUS_COLOR_STYLE = {
  "--trees-git-added-color-override": "var(--success)",
  "--trees-git-modified-color-override": "var(--warning)",
  "--trees-git-deleted-color-override": "var(--destructive)",
  "--trees-git-renamed-color-override":
    "color-mix(in srgb, var(--warning) 60%, var(--destructive))",
  "--trees-git-untracked-color-override": "var(--info)",
} as CSSProperties;

/**
 * Pierre labels an untracked file `U`, which git uses for a conflict. The IDE,
 * like `git status --short`, shows `?`; the label is swapped in CSS because
 * Pierre's letters are not configurable.
 */
const UNTRACKED_LETTER_CSS = `
  [data-item-git-status='untracked'] > [data-item-section='git'] > span { font-size: 0; }
  [data-item-git-status='untracked'] > [data-item-section='git'] > span::after {
    content: '?';
    font-size: var(--trees-font-size-override, 12px);
  }
`;

interface DiffFileTreeProps {
  readonly entries: ReadonlyArray<DiffFileTreeEntry>;
  readonly onSelectFile: (path: string) => void;
  readonly selectedPath?: string | null;
  readonly revealRequestId?: number;
  readonly ariaLabel: string;
  /** The header's label. */
  readonly title?: string;
  /** False for a host that draws its own header above the tree. */
  readonly showHeader?: boolean;
  /** Text after a file's name, such as its line counts. Directories get none. */
  readonly renderFileDecoration?: (path: string) => FileTreeRowDecoration | null;
  /** Right-aligned content in the header row, after the file count. */
  readonly headerAccessory?: ReactNode;
  readonly footer?: ReactNode;
  readonly className?: string;
}

export function DiffFileTree({
  entries,
  onSelectFile,
  selectedPath = null,
  revealRequestId = 0,
  ariaLabel,
  title = "Files",
  showHeader = true,
  renderFileDecoration,
  headerAccessory,
  footer,
  className,
}: DiffFileTreeProps) {
  const { resolvedTheme } = useTheme();
  const paths = entries.map((entry) => entry.path);
  const presented = diffFileTreeModel(paths);
  const modelPaths = presented.paths;
  const icons = presented.icons;
  const directoryPaths = collectDirectoryPaths(modelPaths);
  const positions = diffFileTreePositions(modelPaths);
  const [ordering] = useState(() => {
    let currentPositions: ReadonlyMap<string, number> = new Map();
    return {
      sort: compareDiffFileTreeEntries(() => currentPositions),
      update: (nextPositions: ReadonlyMap<string, number>) => {
        currentPositions = nextPositions;
      },
    };
  });
  const gitStatus = (() => entries.map((entry) => ({ path: presented.modelPath(entry.path), status: entry.status })))();
  const filePathsRef = useRef<ReadonlySet<string>>(new Set(paths));
  const onSelectFileRef = useRef(onSelectFile);
  // Pierre takes the renderer once, at creation; the ref keeps it current.
  const renderFileDecorationRef = useRef(renderFileDecoration);
  // Selection driven by `selectedPath` below is an echo of a file already on screen, not a
  // request to scroll to it again.
  const syncingSelectionRef = useRef(false);
  const handledRevealRef = useRef<{
    path: string;
    revealRequestId: number;
  } | null>(null);
  const mountedPresentationRef = useRef<ReturnType<typeof diffFileTreeModel> | null>(null);

  // The tree model keeps the first selection handler it was given.
  const handleSelectionChange = useStableCallback((selectedPaths: ReadonlyArray<string>) => {
    if (syncingSelectionRef.current) return;
    const modelPath = selectedPaths.at(-1);
    if (modelPath && modelPaths.includes(modelPath)) {
      onSelectFile(presented.selectionPath(modelPath));
    }
  });

  const { model } = useFileTree({
    density: "compact",
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    icons,
    onSelectionChange: handleSelectionChange,
    paths: [],
    renderRowDecoration: ({ item }) =>
      item.kind === "file" ? (renderFileDecorationRef.current?.(item.path) ?? null) : null,
    search: false,
    sort: ordering.sort,
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS + UNTRACKED_LETTER_CSS,
  });
  // Fork: the keyboard way into the tree, and its half-page moves.
  const { bind: bindPaneEntry, onKeyDown: onPaneEntryKeyDown } = usePierreTreePaneEntry(model);
  const allDirectoriesExpanded = useFileTreeSelector(model, (currentModel) =>
    areAllDirectoriesExpanded(currentModel, directoryPaths),
  );

  useEffect(() => {
    model.setIcons(icons);
  }, [icons, model]);

  useEffect(() => {
    ordering.update(positions);
    const mounted = mountedPresentationRef.current;
    if (mounted?.paths === modelPaths) return;
    mountedPresentationRef.current = presented;
    if (mounted === null) {
      model.resetPaths(modelPaths);
    } else if (mounted.paths.every((path, index) => modelPaths[index] === path)) {
      const updates = buildDiffFileTreeUpdates(mounted.paths, modelPaths);
      if (updates.length > 0) model.batch(updates);
    } else {
      // A reset can turn a file path into a directory. Carry selection and focus
      // through real paths so paging keeps the same file without revealing it again.
      const focusedPath = model.getFocusedPath();
      const nextFocusedPath =
        focusedPath === null ? null : presented.modelPath(mounted.selectionPath(focusedPath));
      const selectedPaths = model
        .getSelectedPaths()
        .map((path) => presented.modelPath(mounted.selectionPath(path)))
        .filter((path) => path.endsWith("/") || modelPaths.includes(path));
      const collapsedDirectories = directoryPaths.filter((path) => {
        const directory = model.getItem(path);
        return directory !== null && "isExpanded" in directory && !directory.isExpanded();
      });
      syncingSelectionRef.current = true;
      model.resetPaths(modelPaths);
      for (const path of model.getSelectedPaths()) model.getItem(path)?.deselect();
      for (const path of selectedPaths) model.getItem(path)?.select();
      queueMicrotask(() => {
        syncingSelectionRef.current = false;
      });
      for (const path of collapsedDirectories) {
        const directory = model.getItem(path);
        if (directory !== null && "collapse" in directory) directory.collapse();
      }
      if (
        nextFocusedPath !== null &&
        (modelPaths.includes(nextFocusedPath) || directoryPaths.includes(nextFocusedPath))
      ) {
        model.focusPath(nextFocusedPath);
      }
    }
    model.setGitStatus(gitStatus);
  }, [directoryPaths, gitStatus, model, modelPaths, ordering, positions, presented]);

  useEffect(() => {
    // Updating the renderer ref alone leaves counts stale when paths and Git statuses
    // stay unchanged. Pierre's public render API updates the mounted view without
    // replacing its model, selection, expansion or virtualized viewport.
    renderFileDecorationRef.current = renderFileDecoration;
    const fileTreeContainer = model.getFileTreeContainer();
    if (fileTreeContainer !== undefined) model.render({ fileTreeContainer });
  }, [model, renderFileDecoration]);

  useEffect(() => {
    if (selectedPath === null) {
      handledRevealRef.current = null;
      return;
    }
    const modelPath = presented.modelPath(selectedPath);
    const item = model.getItem(modelPath);
    if (item === null || item.isDirectory()) {
      handledRevealRef.current = null;
      return;
    }
    const handled = handledRevealRef.current;
    if (handled?.path === selectedPath && handled.revealRequestId === revealRequestId) {
      return;
    }
    handledRevealRef.current = { path: selectedPath, revealRequestId };
    syncingSelectionRef.current = true;
    for (const path of model.getSelectedPaths()) {
      if (path !== modelPath) model.getItem(path)?.deselect();
    }
    let ancestor = "";
    for (const segment of modelPath.split("/").slice(0, -1)) {
      ancestor += `${segment}/`;
      const directory = model.getItem(ancestor);
      if (directory !== null && "expand" in directory) directory.expand();
    }
    item.select();
    model.scrollToPath(modelPath, { offset: "nearest" });
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
  }, [model, presented, revealRequestId, selectedPath]);

  return (
    <div
      ref={bindPaneEntry}
      data-pane-entry="1"
      onKeyDown={onPaneEntryKeyDown}
      className={cn("flex min-h-0 flex-1 flex-col bg-background", className)}
    >
      {showHeader ? (
        <div
          className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 text-xs text-muted-foreground in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
          data-surface-subheader
        >
          <span className="px-1 font-medium text-foreground">{title}</span>
          <span className="ml-auto tabular-nums">{entries.length}</span>
          {headerAccessory}
          {directoryPaths.length > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={
                      allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"
                    }
                    onClick={() =>
                      setAllDirectoriesExpanded(model, directoryPaths, !allDirectoriesExpanded)
                    }
                  />
                }
              >
                <MorphIcon
                  className="size-3.5"
                  icon={allDirectoriesExpanded ? ChevronsDownUp : ChevronsUpDown}
                />
              </TooltipTrigger>
              <TooltipPopup>
                {allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
      <FileTree
        model={model}
        aria-label={ariaLabel}
        onClickCapture={(event) => {
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            event.altKey
          ) {
            return;
          }
          // Pierre does not emit a selection change for its sole selected row.
          // Read selection before the row handles the click so new selections reveal only once.
          const selected = model.getSelectedPaths();
          const path = selected.length === 1 ? selected[0] : undefined;
          if (!path || !modelPaths.includes(path)) return;
          const clickedSelectedRow = event.nativeEvent
            .composedPath()
            .some(
              (node) => node instanceof HTMLElement && node.getAttribute("data-item-path") === path,
            );
          if (clickedSelectedRow) onSelectFile(presented.selectionPath(path));
        }}
        className="min-h-0 flex-1 overflow-hidden"
        style={{ ...pierreTreeStyle(resolvedTheme), ...GIT_STATUS_COLOR_STYLE }}
      />
      {footer}
    </div>
  );
}
