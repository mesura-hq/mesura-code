import { joinPath } from "@symmetria/fm-core/pane";
import {
  FileTree,
  type TreeController,
  type TreePort,
  type TreeRecord,
  useFlashPort,
} from "@symmetria/fm-ui/tree";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import "@symmetria/fm-ui/overview/styles.css";
import "@symmetria/fm-search/ui/styles.css";

import { useComposerHandleContext } from "~/composerHandleContext";
import { registerFocusTarget } from "~/lib/focusTargets";
import { setPaneEntryFocus } from "~/lib/panelSurfaceFocus";

import { showFileTreeContextMenu } from "./fileTreeContextMenu";
import { useFileManagerStore } from "../mesuraFileManager/fileManagerStore";
import { useFileTreeStore } from "./fileTreeStore";
import { relativeToCwd } from "./overviewModelFromEntries";
import { routeKey } from "./keyInput";
import { treeCommandForKey } from "./treeKeymap";
import { type HandledReveal, nextRevealRequest } from "./treeReveal";
import { projectTreeKey, treeShapePersister } from "./treeShapeStorage";
import { leaveFileTree } from "./fileTreeFocusMoves";
import { useProjectOverviewModel } from "./useProjectOverviewModel";
import "../symmetriaIcons.css";
import "../symmetriaOverview.css";
import "./fileTree.css";

interface MesuraFileTreeProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  /** File currently open in the preview pane; revealed and selected in the tree. */
  selectedPath: string | null;
  /** Bumped when the same path should be revealed again (e.g. re-opened from search). */
  selectedPathRevealId: number;
  onOpenFile: (relativePath: string) => void;
  onRefreshSelectedFile?: () => void;
  workspaceMutationId: string | null;
}

/**
 * The tree's own state — cursor, collapsed folders, scroll anchor — outlives
 * this component. The file panel unmounts for a spinner, for Settings and for
 * a thread switch, and a tree that forgot its shape on each of those would be
 * worse than the one it replaced. Bounded and least-recently-used, like the
 * file manager's own `TreeStateCache`. A record is created from the shape
 * persisted for the project, so the first render already shows it.
 */
const records = new Map<string, TreeRecord>();
const RECORD_LIMIT = 8;

function recordFor(environmentId: EnvironmentId, cwd: string): TreeRecord {
  const key = projectTreeKey(environmentId, cwd);
  const existing = records.get(key);
  const record = existing ?? {
    shape: treeShapePersister.restore(environmentId, cwd) ?? {
      selected: cwd,
      collapsed: new Set<string>(),
      preset: null,
      checkpoint: null,
    },
    anchor: null,
    pendingReveal: null,
  };
  records.delete(key);
  records.set(key, record);
  while (records.size > RECORD_LIMIT) {
    const oldest = records.keys().next().value;
    if (oldest === undefined) break;
    records.delete(oldest);
  }
  return record;
}

/** The toolbar's Miller button: the file manager over the window, at this project. */
const openFileManager = () => useFileManagerStore.getState().setOpen(true);

/**
 * The Symmetria file tree, mounted in the files surface.
 *
 * The tree renders the server's file list and never reads a filesystem; keys
 * reach it through its command port from the table in `treeKeymap`, so this
 * host owns every chord; a file it activates goes out through `onOpenFile`,
 * the same route the file picker, diffs and chat links use to reach the editor.
 */
export function MesuraFileTree({
  environmentId,
  cwd,
  projectName,
  selectedPath,
  selectedPathRevealId,
  onOpenFile,
  onRefreshSelectedFile,
  workspaceMutationId,
}: MesuraFileTreeProps) {
  const { model, error, hasData, truncated } = useProjectOverviewModel(
    environmentId,
    cwd,
    workspaceMutationId,
    onRefreshSelectedFile,
  );
  const record = useMemo(() => recordFor(environmentId, cwd), [environmentId, cwd]);
  const composerRef = useComposerHandleContext();
  const wrapper = useRef<HTMLDivElement | null>(null);

  // The viewport is the element that owns the tree's keys; focusing the
  // wrapper would land on a node that eats nothing.
  const focusViewport = useCallback(() => {
    const viewport = wrapper.current?.querySelector<HTMLElement>('[role="tree"]');
    viewport?.focus({ preventScroll: true });
    return viewport !== null && viewport !== undefined;
  }, []);
  useEffect(() => registerFocusTarget("tree", focusViewport), [focusViewport]);
  // The panel's entry when no editor shows beside the tree; a ref callback,
  // because the wrapper first renders after the entries load.
  const wrapperRef = useCallback(
    (element: HTMLDivElement | null) => {
      wrapper.current = element;
      if (!element) return;
      const clearEntry = setPaneEntryFocus(element, focusViewport);
      return () => {
        clearEntry();
        wrapper.current = null;
      };
    },
    [focusViewport],
  );
  // Registered here for as long as the tree is mounted, which is the only time
  // a move out of the tree can be asked for; the composer's owner is upstream's.
  useEffect(
    () =>
      registerFocusTarget("composer", () => {
        const composer = composerRef?.current;
        if (!composer) return false;
        composer.focusAtEnd();
        return true;
      }),
    [composerRef],
  );
  // A chord that opened the surface asked for focus before the tree existed.
  useEffect(() => {
    if (useFileTreeStore.getState().consumePendingFocus()) focusViewport();
  }, [focusViewport]);

  const controller = useRef<TreeController | null>(null);
  const treeKey = projectTreeKey(environmentId, cwd);
  const connect = useCallback((next: TreeController) => {
    controller.current = next;
    return () => {
      if (controller.current === next) controller.current = null;
    };
  }, []);
  const flash = useFlashPort();
  const port = useMemo<TreePort>(
    () => ({ connect, select: () => undefined, flash: flash.port }),
    [connect, flash.port],
  );

  // A file opened from the tree comes back as `selectedPath`; revealing it
  // again would only move a cursor that is already there.
  const openedFromTree = useRef<string | null>(null);
  const handledReveal = useRef<HandledReveal | null>(null);
  useEffect(() => {
    const next = nextRevealRequest(handledReveal.current, selectedPath, selectedPathRevealId);
    handledReveal.current = next.handled;
    if (!next.reveal || selectedPath === null) return;
    if (openedFromTree.current === selectedPath) {
      openedFromTree.current = null;
      return;
    }
    const absolute = joinPath(cwd, selectedPath);
    // Before the tree mounts (entries still loading, or an error shown), the
    // record carries the reveal and the tree resolves it on its first render.
    if (controller.current) controller.current.reveal(absolute);
    else record.pendingReveal = absolute;
  }, [cwd, record, selectedPath, selectedPathRevealId]);

  const onOpen = (absolute: string) => {
    const relative = relativeToCwd(cwd, absolute);
    if (relative === null) return;
    // Re-activating the open file changes no prop, so the guard would go stale.
    openedFromTree.current = relative === selectedPath ? null : relative;
    onOpenFile(relative);
  };

  // Escape leaves the tree the same way Ctrl+E does, hiding it behind the
  // editor when there is one.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) =>
    routeKey(event, {
      flash,
      commandFor: treeCommandForKey,
      onEscape: leaveFileTree,
      onCommand: (command) => controller.current?.command(command),
    });

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    const row = event.target instanceof Element ? event.target.closest("[data-path]") : null;
    const absolute = row instanceof HTMLElement ? row.dataset.path : undefined;
    if (!absolute) return;
    // Every row suppresses the browser's menu; the root row simply offers none.
    event.preventDefault();
    const relative = relativeToCwd(cwd, absolute);
    if (relative === null) return;
    void showFileTreeContextMenu({
      relativePath: relative,
      position: { x: event.clientX, y: event.clientY },
      composer: composerRef?.current ?? null,
    });
  };

  if (error !== null && !hasData) {
    return <div className="p-4 text-xs leading-relaxed text-destructive">{error}</div>;
  }
  return (
    // The tree viewport inside owns focus and the tree role; this wrapper only routes keys and the menu.
    <div
      ref={wrapperRef}
      role="group"
      data-mesura-file-tree={treeKey}
      data-pane-entry="1"
      aria-label={`${projectName} files`}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
    >
      <FileTree
        root={cwd}
        model={model}
        port={port}
        record={record}
        onOpen={onOpen}
        onShapeChange={(shape) => {
          // An incomplete listing cannot prove a folder gone; the tree's own
          // pruning would drop it, and persisting that would lose the fold.
          if (!truncated) treeShapePersister.persist(environmentId, cwd, shape);
        }}
        autoFocus={false}
        showScope={false}
        onMiller={openFileManager}
      />
      {truncated ? (
        <p className="mesura-file-tree-notice">
          The server listed only part of this project; some files are missing here.
        </p>
      ) : null}
    </div>
  );
}
