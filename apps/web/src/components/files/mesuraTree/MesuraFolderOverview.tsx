import type { OverviewCommand } from "@symmetria/fm-core/overview/navigation";
import { OverviewLayer, type OverviewModel, type OverviewPort } from "@symmetria/fm-ui/overview";
import { useFlashPort } from "@symmetria/fm-ui/tree";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { useFileTreeStore } from "./fileTreeStore";
import { routeKey } from "./keyInput";
import { revealInTree } from "./MesuraFileTree";
import { entryKindAt, relativeToCwd } from "./overviewModelFromEntries";
import { overviewCommandForKey } from "./overviewKeymap";
import { overviewViewStore } from "./overviewViewStorage";
import { useProjectOverviewModel } from "./useProjectOverviewModel";

interface MesuraFolderOverviewProps {
  environmentId: EnvironmentId;
  cwd: string;
  onOpenFile: (relativePath: string) => void;
  workspaceMutationId: string | null;
}

/**
 * The file manager's zoomable folder overview, over the window, for the
 * project the files surface shows. Mounted only while open, so a closed
 * overview costs the panel nothing: no second listing subscription, no second
 * folder map. Keyed by project so a thread switch under it starts afresh.
 */
export function MesuraFolderOverview(props: MesuraFolderOverviewProps) {
  const open = useFileTreeStore((state) => state.overviewOpen);
  return open ? (
    <FolderOverviewLayer key={`${props.environmentId}:${props.cwd}`} {...props} />
  ) : null;
}

/**
 * The layer renders the same model the tree does; choosing an entry in it
 * reveals that entry in the tree and, for a file, opens it in the editor.
 * Portalled to `body` so the panel's overflow cannot clip it, and keyed by the
 * graph's root so re-rooting on a folder remounts the graph the way the file
 * manager's own host does.
 */
function FolderOverviewLayer({
  environmentId,
  cwd,
  onOpenFile,
  workspaceMutationId,
}: MesuraFolderOverviewProps) {
  const setOverviewOpen = useFileTreeStore((state) => state.setOverviewOpen);
  const { model } = useProjectOverviewModel(environmentId, cwd, workspaceMutationId);
  // The folder the graph was re-rooted on through its port, if any.
  const [focused, setFocused] = useState<string | null>(null);
  const root = focused ?? cwd;
  const close = useCallback(() => setOverviewOpen(false), [setOverviewOpen]);

  const handler = useRef<(command: OverviewCommand) => void>(() => undefined);
  const connect = useCallback((next: (command: OverviewCommand) => void) => {
    handler.current = next;
    return () => {
      if (handler.current === next) handler.current = () => undefined;
    };
  }, []);
  const flash = useFlashPort();
  const [minimapVisible, setMinimapVisible] = useState(true);
  const toggleMinimap = () => setMinimapVisible((visible) => !visible);

  const latest = useRef({ model, close, onOpenFile });
  latest.current = { model, close, onOpenFile };
  const reveal = useCallback(
    (absolute: string) => {
      const current = latest.current;
      current.close();
      revealInTree(environmentId, cwd, absolute);
      const relative = relativeToCwd(cwd, absolute);
      if (relative !== null && entryKindAt(current.model.folders, absolute) === "file")
        current.onOpenFile(relative);
    },
    [cwd, environmentId],
  );
  const port = useMemo<OverviewPort>(
    () => ({ flash: flash.port, connect, reveal, focus: setFocused }),
    [connect, flash.port, reveal],
  );

  // The view is read once when the graph mounts for a root, and saved by the
  // graph while it is up; both keyed by the root the graph shows.
  const view = useMemo(() => overviewViewStore.load(environmentId, root), [environmentId, root]);
  const overviewModel = useMemo<OverviewModel>(
    () => ({
      ...model,
      view: view ?? undefined,
      saveView: (next) => overviewViewStore.save(environmentId, root, next),
    }),
    [environmentId, model, root, view],
  );

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) =>
    routeKey(event, {
      flash,
      commandFor: overviewCommandForKey,
      // The layer's own capture handler closes an open popover on Escape and
      // stops the event there; one that reaches this bubble handler closes
      // the overview.
      onEscape: close,
      onCommand: (command) => {
        if (command === "toggle-minimap") toggleMinimap();
        else handler.current(command);
      },
    });

  return createPortal(
    // The layer inside is the dialog; this wrapper only routes keys to its port.
    <div data-mesura-folder-overview onKeyDown={onKeyDown}>
      <OverviewLayer
        root={root}
        model={overviewModel}
        onClose={close}
        port={port}
        minimapVisible={minimapVisible}
        onToggleMinimap={toggleMinimap}
      />
    </div>,
    document.body,
  );
}
