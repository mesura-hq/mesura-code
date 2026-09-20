import type { ViewKind } from "@symmetria/fm-core/keys/types";
import type { OverviewCommand } from "@symmetria/fm-core/overview/navigation";
import { useCallback, useRef, useState } from "react";
import { type FlashPort, useFlashPort } from "../flash/useFlashPort.ts";
import { OVERVIEW_LIMITS, TREE_AUTOMATIC_DEPTH } from "./limits.ts";
import { type OverviewModel, useOverview } from "./useOverview.ts";
import { type TreeOriginHost, useOverviewNavigation } from "./useOverviewNavigation.ts";
export interface OverviewPort {
  readonly flash?: FlashPort;
  connect(handler: (command: OverviewCommand) => void): () => void;
  reveal(path: string): void;
  focus(path: string): void;
}
export function useOverviewMode(
  path: string,
  showHidden: boolean,
  openAt: (path: string) => void,
  reveal: (path: string) => void,
  navigate: (path: string) => void,
  treeRoot: string | null = null,
  tree?: TreeOriginHost,
) {
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
  const command = (name: OverviewCommand) => {
    if (name === "toggle-minimap") toggleMinimap();
    else handler.current(name);
  };
  const navigation = useOverviewNavigation({ path, treeRoot, tree, reveal, navigate });
  const { root, close } = navigation;
  const model = useOverview(
    root ?? treeRoot,
    showHidden,
    root === null ? TREE_AUTOMATIC_DEPTH : OVERVIEW_LIMITS.automaticDepth,
  );
  const treeModel = usePreservedTreeModel(root, treeRoot, model);
  const openExternal = useCallback(
    (next: string) => {
      close();
      openAt(next);
    },
    [openAt, close],
  );
  const view: ViewKind = root === null ? "miller" : "overview";
  return {
    flashActive: root !== null && flash.active,
    onFlashKey: flash.onKey,
    minimapVisible,
    toggleMinimap,
    root,
    model,
    treeModel,
    revealDestination: navigation.revealDestination,
    close,
    toggle: navigation.toggle,
    openExternal,
    view,
    command,
    port: {
      flash: flash.port,
      connect,
      reveal: navigation.reveal,
      focus: navigation.focus,
    },
  };
}

function usePreservedTreeModel(root: string | null, treeRoot: string | null, model: OverviewModel) {
  const preserved = useRef(model);
  if (root === null && treeRoot !== null) preserved.current = model;
  return root !== null ? preserved.current : model;
}
