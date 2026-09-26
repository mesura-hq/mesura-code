import { openPath } from "@symmetria/fm-ui/bridge";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useRightPanelStore } from "~/rightPanelStore";
import { useProject } from "~/state/entities";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { createFileManagerTransport, fileManagerHost } from "~/state/fileManagerRpc";
import { useEnvironmentQuery } from "~/state/query";

import { installFileManagerBridge } from "./bridgeInstall";
import { useFileManagerStore } from "./fileManagerStore";
import { type FileManagerTarget, fileManagerTarget } from "./fileManagerTarget";
import { FILE_MANAGER_ROOT_ATTRIBUTE } from "./isFileManagerOpen";
import { decideOpenFromFileManager } from "./openFromFileManager";
import { createWsBridge, type WsBridge } from "./wsBridge";
import "../symmetriaIcons.css";
import "../symmetriaOverview.css";
import "./fileManager.css";

// The file manager brings its previews with it — spreadsheets, audio tags,
// a highlighter — and none of that belongs in the bundle a chat needs.
const FileManagerApp = lazy(() =>
  import("@symmetria/fm-ui/App").then((module) => ({ default: module.App })),
);

/** The layer's ways out: a stray Escape, a file opened, a lost session, the thread leaving the route. */
const closeFileManager = () => useFileManagerStore.getState().setOpen(false);

interface MesuraFileManagerLayerProps {
  readonly routeThreadRef: ScopedThreadRef | null;
  readonly activeThread: EnvironmentThread | null;
}

/**
 * The Symmetria file manager over the window, at the active thread's
 * project. Mounted once from the chat route; renders nothing until the
 * chord, the tree's Miller button or a store write opens it. Keyed on the
 * project, so a thread switch while it is up remounts it there.
 */
export function MesuraFileManagerLayer({
  routeThreadRef,
  activeThread,
}: MesuraFileManagerLayerProps) {
  const open = useFileManagerStore((state) => state.open);
  const project = useProject(
    activeThread ? scopeProjectRef(activeThread.environmentId, activeThread.projectId) : null,
  );
  // The projection behind `target` can be empty for a moment — before it
  // first lands, or while a reconnect repopulates it — and a layer that
  // unmounted on each blip would lose its tabs and cursor. The last target
  // holds while the thread stays; only the thread leaving the route closes
  // the layer, or the next chord would flip a flag nobody can see.
  const lastTarget = useRef<FileManagerTarget | null>(null);
  const target = fileManagerTarget(activeThread, project) ?? lastTarget.current;
  useEffect(() => {
    lastTarget.current = target;
  });
  useEffect(() => {
    if (open && routeThreadRef === null) closeFileManager();
  }, [open, routeThreadRef]);
  if (!open || target === null || routeThreadRef === null) return null;
  return (
    <OpenFileManager
      key={`${target.environmentId}:${target.cwd}`}
      routeThreadRef={routeThreadRef}
      environmentId={target.environmentId}
      cwd={target.cwd}
    />
  );
}

interface OpenFileManagerProps {
  readonly routeThreadRef: ScopedThreadRef;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

function OpenFileManager({ routeThreadRef, environmentId, cwd }: OpenFileManagerProps) {
  const host = useEnvironmentQuery(fileManagerHost({ environmentId, input: {} }));
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const latest = useRef({ httpBaseUrl });
  useEffect(() => {
    latest.current = { httpBaseUrl };
  });

  // The bridge is installed on the window before the file manager mounts:
  // its hooks call the bridge from their mount effects, which would run
  // before an effect of this component installed it.
  const [bridge, setBridge] = useState<WsBridge | null>(null);
  useEffect(() => {
    const created = createWsBridge(createFileManagerTransport(environmentId), {
      close: closeFileManager,
      httpBaseUrl: () => latest.current.httpBaseUrl ?? "",
      clipboard: {
        writeText: (text) => navigator.clipboard.writeText(text),
        writeImage: (blob) => navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]),
      },
      fetchBlob: async (url) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`the preview answered ${response.status}`);
        return response.blob();
      },
      onSessionLost: () => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "The file manager lost its connection",
            description: "Open it again to reconnect.",
          }),
        );
        closeFileManager();
      },
    });
    const remove = installFileManagerBridge(created);
    setBridge(created);
    return () => {
      setBridge(null);
      remove();
      created.dispose();
    };
  }, [environmentId]);

  // The dialog takes focus on mount and hands it back on unmount, the way
  // the file manager's own dialogs do (`useDialogFocus`).
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const origin = document.activeElement;
    root.current?.focus({ preventScroll: true });
    return () => {
      if (origin instanceof HTMLElement && origin.isConnected)
        origin.focus({ preventScroll: true });
    };
  }, []);

  const onOpenFile = (absolutePath: string) => {
    const decision = decideOpenFromFileManager(cwd, absolutePath);
    if (decision.kind === "editor") {
      useRightPanelStore.getState().openFile(routeThreadRef, decision.relativePath);
      closeFileManager();
      return;
    }
    void openPath(absolutePath).then((result) => {
      if (result.ok) return;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not open",
          description: result.error.message,
        }),
      );
    });
  };

  const homePath = host.data?.homePath;
  const showing = bridge !== null && homePath !== undefined;
  // While the notice shows there is no file manager to take Escape, so the
  // layer takes it: a failed host lookup must not need the chord to leave.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (showing || event.key !== "Escape") return;
    event.preventDefault();
    closeFileManager();
  };
  return createPortal(
    <div
      ref={root}
      {...{ [FILE_MANAGER_ROOT_ATTRIBUTE]: "" }}
      role="dialog"
      aria-modal="true"
      aria-label="File manager"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {showing ? (
        <Suspense fallback={null}>
          <FileManagerApp
            startPath={cwd}
            homePath={homePath}
            onOpenFile={onOpenFile}
            onDismiss={closeFileManager}
          />
        </Suspense>
      ) : (
        <p className="mesura-file-manager-notice">{host.error ?? "Opening the file manager…"}</p>
      )}
    </div>,
    document.body,
  );
}
