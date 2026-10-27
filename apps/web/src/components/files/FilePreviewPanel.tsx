import { joinPath } from "@symmetria/fm-core/pane";
import { useAtomValue } from "@effect/atom-react";
import { DownloadIcon, CopyIcon, CheckIcon } from "lucide-react";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Spinner } from "~/components/ui/spinner";
import { useFileSurfacePending } from "./fileSurfacePendingStore";
import {
  AuthPreviewOperateScope,
  type EditorId,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { filePreviewDelimiter } from "@t3tools/shared/delimitedPreview";
import { AuthFilesystemWriteScope } from "@t3tools/contracts";
import {
  isWorkspaceAudioPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspaceFontPreviewPath,
  isWorkspaceVideoPreviewPath,
  officePreviewKind,
  binaryPreviewKind,
} from "@t3tools/shared/filePreview";
import { VirtualizedFile } from "@pierre/diffs";
import { type FileOptions } from "@pierre/diffs/react";
import { useFilesystemReadAccess } from "~/state/filesystem";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { mediaFileReference } from "@t3tools/client-runtime/media-reference";
import { FolderTree, Globe2, WrapTextIcon } from "lucide-react";
import { Code2, Eye, Table2 } from "lucide";
import * as Schema from "effect/Schema";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { isBrowserPreviewFile, openFileInPreview } from "~/browser/openFileInPreview";
import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { OpenInPicker } from "~/components/chat/OpenInPicker";
import { MediaVideoPlayer } from "~/components/media/MediaVideoPlayer";
import { MediaActions, type MediaActionSource } from "~/components/media/MediaActions";
import { MorphIcon } from "~/components/MorphIcon";
import { useRemoteOpenState } from "~/remoteOpen";
import { useClientSettings, updateClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { previewFocusTargetRef } from "~/lib/panelSurfaceFocus";
import { cn } from "~/lib/utils";
import type { ChatFileAttachment } from "~/types";
import { isHostPath } from "@t3tools/shared/path";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { ScrollArea } from "~/components/ui/scroll-area";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { type DraftId } from "~/composerDraftStore";
import { assetEnvironment } from "~/state/assets";
import { usePreviewAvailable } from "~/browser/previewRuntime";
import { useEnvironmentHttpBaseUrl, usePrimaryEnvironmentId } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { useFileTreeStore } from "./mesuraTree/fileTreeStore";
import { MesuraFileTree } from "./mesuraTree/MesuraFileTree";
import { AttachmentFilePreview } from "./AttachmentFilePreview";
import { AudioPreview } from "./AudioPreview";
import { BrowserDocumentFrame, isPdfPreviewFile } from "./BrowserDocumentFrame";
import { DelimitedTablePreview } from "./DelimitedTablePreview";
import { PreviewImage } from "./PreviewImage";
import { FileBreadcrumbs } from "./FileBreadcrumbs";
import { breadcrumbPathOf, retainedBreadcrumbTrail, trailChildOf } from "./filePath";
import { FileMarkdownPreview } from "./FileMarkdownPreview";
import {
  FILE_LINK_REVEAL_ATTRIBUTE,
  FILE_SURFACE_SUBHEADER_CLASS,
  FileSurfaceAction,
  FileSurfaceFailure,
  FileSurfaceLoading,
} from "./fileSurfaceChrome";
import SourceFilePreview from "./ReadOnlySourcePreview";
import { resolveCenteredFileLineScrollTop } from "./fileLineReveal";
import { projectFileCacheKey } from "./fileContentRevision";
import { useProjectEditorModels } from "./monaco/useProjectEditorModels";
import { useProjectFileWatch } from "./useProjectFileWatch";
import { MonacoFileSurface } from "./monaco/MonacoFileSurface";
import {
  filePreviewReadErrorMessage,
  isMarkdownPreviewFile,
  resolveFilePreviewPath,
  setMarkdownTaskChecked,
  shouldShowFileExplorer,
  workspaceAssetResource,
} from "./filePreviewMode";
import { useFileSaveCoordinator, type FileSaveCoordinatorInput } from "./useFileSaveCoordinator";
import {
  getOptimisticProjectFileQueryData,
  setProjectFileQueryData,
  useProjectFileQuery,
} from "./projectFilesQueryState";

interface FilePreviewPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  relativePath: string | null;
  attachment?: ChatFileAttachment;
  threadRef: ScopedThreadRef;
  composerDraftTarget: ScopedThreadRef | DraftId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInShortcutEnabled: boolean;
  revealLine: number | null;
  revealRequestId: number;
  onOpenFile: (relativePath: string) => void;
  onNavigateFolder: (relativePath: string, folderTrail: string, keepSource: boolean) => void;
  /** Retained descendant breadcrumb path after navigating up; see navigateFolder. */
  folderTrail: string | undefined;
  onPendingChange: (relativePath: string, pending: boolean) => void;
  /** Mesura: the project the pending-save flags are kept under; see `fileSurfacePendingStore`. */
  pendingProjectKey?: string | null;
  selectedFilePending?: boolean;
  workspaceMutationId: string | null;
  /** Fork addition: this tab hides the explorer whatever the shared preference says. */
  explorerHidden?: boolean;
  onRevealExplorer?: () => void;
}

const MermaidFilePreview = lazy(() =>
  import("./MermaidFilePreview").then((module) => ({ default: module.MermaidFilePreview })),
);

const RENDER_MARKDOWN_STORAGE_KEY = "t3code.renderMarkdown";
const RENDER_BROWSER_FILE_STORAGE_KEY = "t3code.renderBrowserFile";
const RENDER_TABLE_STORAGE_KEY = "t3code.renderTable";
type FilePostRender = NonNullable<FileOptions<unknown, undefined>["onPostRender"]>;

function WorkspaceImagePreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly draft: boolean;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly alt: string;
  readonly workspaceMutationId: string | null;
}) {
  const resource = workspaceAssetResource({
    kind:
      mediaFileReference(props.absolutePath, props.workspaceRoot).relativePath !== undefined
        ? "workspace-file"
        : "media-file",
    threadRef: props.threadRef,
    draft: props.draft,
    workspaceRoot: props.workspaceRoot,
    absolutePath: props.absolutePath,
  });
  const assetUrl = useAssetUrlState(props.environmentId, resource);
  const revisionSuffix =
    props.workspaceMutationId === null
      ? ""
      : `${assetUrl._tag === "Success" && assetUrl.url.includes("?") ? "&" : "?"}workspace-revision=${encodeURIComponent(props.workspaceMutationId)}`;
  const imageUrl = assetUrl._tag === "Success" ? `${assetUrl.url}${revisionSuffix}` : null;
  const actionsSource: MediaActionSource = {
    kind: "image",
    name: props.alt,
    src: imageUrl,
    reference: mediaFileReference(props.absolutePath, props.workspaceRoot),
    asset: { environmentId: props.environmentId, resource },
  };

  if (assetUrl._tag === "Failure") {
    return (
      <MediaActions source={actionsSource}>
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
          Unable to load workspace image.
        </div>
      </MediaActions>
    );
  }

  return assetUrl._tag === "Success" && imageUrl !== null ? (
    // The entry sits outside MediaActions: its trigger takes tabIndex 0, and a focusable
    // entry takes focus itself instead of the image's scroll region.
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      data-pane-entry="2"
      ref={previewFocusTargetRef}
    >
      <MediaActions source={actionsSource}>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <PreviewImage key={imageUrl} src={imageUrl} name={props.alt} />
        </div>
      </MediaActions>
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
      <Spinner size="lg" />
    </div>
  );
}

function WorkspaceBrowserPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly draft: boolean;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly title: string;
  readonly workspaceMutationId: string | null;
}) {
  const resource = workspaceAssetResource({
    kind: "workspace-file",
    threadRef: props.threadRef,
    draft: props.draft,
    workspaceRoot: props.workspaceRoot,
    absolutePath: props.absolutePath,
  });
  const assetUrl = useAssetUrlState(props.environmentId, resource);
  const revisionSuffix =
    props.workspaceMutationId === null
      ? ""
      : `${assetUrl._tag === "Success" && assetUrl.url.includes("?") ? "&" : "?"}workspace-revision=${encodeURIComponent(props.workspaceMutationId)}`;

  if (assetUrl._tag === "Failure") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
        Unable to load file preview.
      </div>
    );
  }
  if (assetUrl._tag !== "Success") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <Spinner size="lg" />
      </div>
    );
  }
  return (
    <BrowserDocumentFrame
      src={`${assetUrl.url}${revisionSuffix}`}
      documentKey={`${props.environmentId}:${resource._tag}:${props.threadRef.threadId}:${props.absolutePath}:${props.workspaceMutationId}`}
      title={props.title}
      pdf={isPdfPreviewFile(props.absolutePath)}
    />
  );
}

function WorkspaceVideoPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly draft: boolean;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly name: string;
  readonly workspaceMutationId: string | null;
}) {
  const resource = workspaceAssetResource({
    kind: "media-file",
    threadRef: props.threadRef,
    draft: props.draft,
    workspaceRoot: props.workspaceRoot,
    absolutePath: props.absolutePath,
  });
  const assetUrl = useAssetUrlState(props.environmentId, resource);
  const refreshAssetUrl = useAssetUrlRefresh(props.environmentId, resource);
  useWorkspaceMutationRefresh({
    mutationId: props.workspaceMutationId,
    resourceKey: JSON.stringify([props.environmentId, resource]),
    refresh: () => {
      void refreshAssetUrl().catch(() => undefined);
    },
  });
  // Servers that report the file's revision let an unchanged file stay loaded; older ones
  // only offer the workspace mutation, which changes after every command. The revision also
  // goes in the URL, since two mints in the same millisecond sign identical URLs.
  const fileRevision = assetUrl._tag === "Success" ? assetUrl.fileRevision : undefined;
  const revision = fileRevision ?? props.workspaceMutationId;
  const revisionSuffix =
    revision === null
      ? ""
      : `${assetUrl._tag === "Success" && assetUrl.url.includes("?") ? "&" : "?"}${fileRevision !== undefined ? "file" : "workspace"}-revision=${encodeURIComponent(revision)}`;
  const latestUrl = assetUrl._tag === "Success" ? `${assetUrl.url}${revisionSuffix}` : null;

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
      <MediaVideoPlayer
        src={latestUrl}
        sourceFailed={assetUrl._tag === "Failure"}
        label={props.name}
        revision={revision}
        preload="metadata"
        className="flex h-full min-h-0 w-full max-w-5xl items-center justify-center"
        onRetry={refreshAssetUrl}
        actionsSource={{
          kind: "video",
          name: props.name,
          src: latestUrl,
          reference: mediaFileReference(props.absolutePath, props.workspaceRoot),
          asset: { environmentId: props.environmentId, resource },
        }}
      />
    </div>
  );
}

function WorkspaceAudioPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly draft: boolean;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly name: string;
  readonly workspaceMutationId: string | null;
}) {
  const resource = workspaceAssetResource({
    kind: "media-file",
    threadRef: props.threadRef,
    draft: props.draft,
    workspaceRoot: props.workspaceRoot,
    absolutePath: props.absolutePath,
  });
  const assetUrl = useAssetUrlState(props.environmentId, resource);
  const refreshAssetUrl = useAssetUrlRefresh(props.environmentId, resource);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  useWorkspaceMutationRefresh({
    mutationId: props.workspaceMutationId,
    resourceKey: JSON.stringify([props.environmentId, resource]),
    refresh: () => {
      void refreshAssetUrl().catch(() => undefined);
    },
  });
  const fileRevision = assetUrl._tag === "Success" ? assetUrl.fileRevision : undefined;
  const revision = fileRevision ?? props.workspaceMutationId;
  const revisionSuffix =
    revision === null
      ? ""
      : `${assetUrl._tag === "Success" && assetUrl.url.includes("?") ? "&" : "?"}${fileRevision !== undefined ? "file" : "workspace"}-revision=${encodeURIComponent(revision)}`;
  const url = assetUrl._tag === "Success" ? `${assetUrl.url}${revisionSuffix}` : null;
  if (assetUrl._tag === "Failure" || (url !== null && failedUrl === url)) {
    return (
      <FileSurfaceFailure
        message="Unable to load audio."
        onRetry={() => {
          setFailedUrl(null);
          void refreshAssetUrl().catch(() => undefined);
        }}
      />
    );
  }
  if (url === null) return <FileSurfaceLoading />;
  return (
    <AudioPreview
      src={url}
      name={props.name}
      revision={revision}
      onError={() => setFailedUrl(url)}
    />
  );
}

function clampFileLine(contents: string, requestedLine: number): number {
  let lineCount = 1;
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents.charCodeAt(index);
    if (character === 10) {
      lineCount += 1;
    } else if (character === 13) {
      lineCount += 1;
      if (contents.charCodeAt(index + 1) === 10) index += 1;
    }
  }
  return Math.min(Math.max(1, requestedLine), lineCount);
}

function updateFileLinkReveal(fileContainer: HTMLElement, line: number | null): void {
  const root = fileContainer.shadowRoot ?? fileContainer;
  for (const element of root.querySelectorAll<HTMLElement>(`[${FILE_LINK_REVEAL_ATTRIBUTE}]`)) {
    element.removeAttribute(FILE_LINK_REVEAL_ATTRIBUTE);
  }
  if (line === null) return;

  root
    .querySelector<HTMLElement>(`[data-line="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, "");
  root
    .querySelector<HTMLElement>(`[data-column-number="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, "");
}

const REVEAL_MAX_ATTEMPTS = 30;
/** Hold the reveal target against late focus/restoration scroll resets. */
const REVEAL_GUARD_FRAMES = 20;
const REVEAL_GUARD_TOLERANCE_PX = 2;

interface FileRevealState {
  frameId: number | null;
  cancelGuard: (() => void) | null;
  handledRequestId: number | null;
  latestRequestId: number | null;
}

function useFileLineReveal(
  relativePath: string | null,
  revealLine: number | null,
  revealRequestId: number,
): FilePostRender {
  const [revealStatesByPath] = useState(() => new Map<string, FileRevealState>());

  return (fileContainer, instance, phase) => {
    if (relativePath === null) return;

    const existingState = revealStatesByPath.get(relativePath);
    const state: FileRevealState = existingState ?? {
      frameId: null,
      cancelGuard: null,
      handledRequestId: null,
      latestRequestId: null,
    };
    if (!existingState) revealStatesByPath.set(relativePath, state);

    const cancelPendingReveal = () => {
      if (state.frameId !== null) {
        cancelAnimationFrame(state.frameId);
        state.frameId = null;
      }
      state.cancelGuard?.();
    };

    if (phase === "unmount") {
      cancelPendingReveal();
      return;
    }

    const contents = instance.file?.contents;
    const targetLine =
      revealLine === null || contents === undefined ? null : clampFileLine(contents, revealLine);
    updateFileLinkReveal(fileContainer, targetLine);

    if (!(instance instanceof VirtualizedFile)) return;

    if (state.latestRequestId !== revealRequestId) {
      cancelPendingReveal();
      state.latestRequestId = revealRequestId;
      state.handledRequestId = null;
    }

    if (revealLine === null) {
      fileContainer.style.minHeight = "";
      return;
    }

    const scrollContainer = fileContainer.closest<HTMLElement>(".file-preview-virtualizer");
    if (!scrollContainer) return;
    fileContainer.style.minHeight = `${Math.ceil(
      Math.max(instance.height, scrollContainer.clientHeight),
    )}px`;

    if (state.handledRequestId === revealRequestId || state.frameId !== null) {
      return;
    }

    const resolveScrollTarget = (line: number): number | null => {
      const linePosition = instance.getLinePosition(line);
      if (!linePosition) return null;

      const scrollContainerRect = scrollContainer.getBoundingClientRect();
      const fileTop =
        scrollContainer.scrollTop +
        fileContainer.getBoundingClientRect().top -
        scrollContainerRect.top;
      const root = fileContainer.shadowRoot ?? fileContainer;
      const renderedLineElement = root.querySelector<HTMLElement>(`[data-line="${line}"]`);
      const renderedLineRect = renderedLineElement?.getBoundingClientRect();

      return resolveCenteredFileLineScrollTop({
        scrollTop: scrollContainer.scrollTop,
        scrollHeight: scrollContainer.scrollHeight,
        viewportTop: scrollContainerRect.top,
        viewportHeight: scrollContainer.clientHeight,
        fileTop,
        estimatedLine: linePosition,
        ...(renderedLineRect && renderedLineRect.height > 0
          ? {
              renderedLine: {
                top: renderedLineRect.top,
                height: renderedLineRect.height,
              },
            }
          : {}),
      });
    };

    const guardScrollTarget = (line: number) => {
      let framesLeft = REVEAL_GUARD_FRAMES;
      let guardFrameId: number | null = null;
      const cancelGuard = () => {
        if (guardFrameId !== null) {
          cancelAnimationFrame(guardFrameId);
          guardFrameId = null;
        }
        scrollContainer.removeEventListener("wheel", cancelGuard);
        scrollContainer.removeEventListener("touchstart", cancelGuard);
        scrollContainer.removeEventListener("pointerdown", cancelGuard, true);
        window.removeEventListener("keydown", cancelGuard, true);
        if (state.cancelGuard === cancelGuard) state.cancelGuard = null;
      };
      scrollContainer.addEventListener("wheel", cancelGuard, { passive: true });
      scrollContainer.addEventListener("touchstart", cancelGuard, { passive: true });
      // Capture gutter pointer events before Pierre stops propagation so comments can cancel the reveal
      // guard.
      scrollContainer.addEventListener("pointerdown", cancelGuard, {
        passive: true,
        capture: true,
      });
      window.addEventListener("keydown", cancelGuard, true);
      const holdTarget = () => {
        guardFrameId = null;
        framesLeft -= 1;
        if (framesLeft <= 0 || !scrollContainer.isConnected) {
          cancelGuard();
          return;
        }
        const targetTop = resolveScrollTarget(line);
        if (
          targetTop !== null &&
          Math.abs(scrollContainer.scrollTop - targetTop) > REVEAL_GUARD_TOLERANCE_PX
        ) {
          scrollContainer.scrollTop = targetTop;
        }
        guardFrameId = requestAnimationFrame(holdTarget);
      };
      guardFrameId = requestAnimationFrame(holdTarget);
      state.cancelGuard = cancelGuard;
    };

    const scheduleReveal = (attempt: number) => {
      state.frameId = requestAnimationFrame(() => {
        state.frameId = null;
        if (state.latestRequestId !== revealRequestId || !fileContainer.isConnected) {
          return;
        }

        // Wait for contents and metrics; missing data would clamp fresh-mount reveals to line 1 and mark them
        // handled.
        const currentContents = instance.file?.contents;
        const line =
          currentContents === undefined ? null : clampFileLine(currentContents, revealLine);
        const targetTop = line === null ? null : resolveScrollTarget(line);
        if (line === null || targetTop === null) {
          if (attempt < REVEAL_MAX_ATTEMPTS) scheduleReveal(attempt + 1);
          return;
        }
        updateFileLinkReveal(fileContainer, line);

        scrollContainer.scrollTop = targetTop;
        state.handledRequestId = revealRequestId;
        guardScrollTarget(line);
      });
    };

    scheduleReveal(0);
  };
}

function RenderedMarkdownSurface({
  environmentId,
  cwd,
  relativePath,
  contents,
  threadRef,
  workspaceMutationId,
  readOnly,
  onPendingChange,
}: FileSaveCoordinatorInput & {
  contents: string;
  threadRef: ScopedThreadRef;
  readOnly: boolean;
  workspaceMutationId: string | null;
}) {
  const saveCoordinator = useFileSaveCoordinator({
    environmentId,
    cwd,
    relativePath,
    onPendingChange,
  });

  return (
    <ScrollArea className="min-h-0 flex-1" data-pane-entry="2" ref={previewFocusTargetRef}>
      <FileMarkdownPreview
        text={contents}
        cwd={cwd}
        relativePath={relativePath}
        threadRef={threadRef}
        workspaceMutationId={workspaceMutationId}
        onTaskListChange={
          readOnly
            ? undefined
            : ({ markerOffset, checked }) => {
                const currentContents =
                  getOptimisticProjectFileQueryData(environmentId, cwd, relativePath)?.contents ??
                  contents;
                const nextContents = setMarkdownTaskChecked(currentContents, markerOffset, checked);
                if (nextContents === currentContents) return;
                setProjectFileQueryData(environmentId, cwd, relativePath, nextContents);
                saveCoordinator.change(nextContents);
              }
        }
      />
    </ScrollArea>
  );
}

function renderedToggleLabel(
  mode: "markdown" | "mermaid" | "html" | "table",
  rendered: boolean,
): string {
  if (mode === "mermaid") return rendered ? "Show Mermaid source" : "Show rendered diagram";
  if (mode === "markdown") return rendered ? "Show markdown source" : "Show rendered markdown";
  if (mode === "table") return rendered ? "Show source" : "Show table";
  return rendered ? "Show HTML source" : "Show rendered page";
}

export default function FilePreviewPanel({
  environmentId,
  cwd,
  projectName,
  relativePath: requestedPath,
  attachment,
  threadRef,
  composerDraftTarget,
  keybindings,
  availableEditors,
  openInShortcutEnabled,
  revealLine,
  revealRequestId,
  onOpenFile,
  onNavigateFolder,
  folderTrail,
  onPendingChange,
  pendingProjectKey = null,
  selectedFilePending: upstreamSelectedFilePending = false,
  workspaceMutationId,
  explorerHidden = false,
  onRevealExplorer,
}: FilePreviewPanelProps) {
  const relativePath =
    attachment === undefined ? resolveFilePreviewPath(requestedPath, cwd) : requestedPath;
  const storedFilePending = useFileSurfacePending(
    pendingProjectKey,
    attachment === undefined && requestedPath !== null ? `file:${requestedPath}` : null,
  );
  const selectedFilePending = storedFilePending || upstreamSelectedFilePending;
  // A draft's composer target is its draft id; a thread the server knows is a ref.
  const draft = typeof composerDraftTarget === "string";
  const { resolvedTheme } = useTheme();
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  const canOperatePreview = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const modalEditing = useClientSettings((settings) => settings.modalEditing);
  // The editor's models live in a registry outside React: the undo stack lives in the Monaco
  // model, and this panel unmounts on route changes (opening Settings, switching to a thread
  // in another project), which no component survives.
  const { models, retention } = useProjectEditorModels(environmentId, cwd);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const remoteOpenState = useRemoteOpenState(environmentId);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const previewAvailable = usePreviewAvailable(environmentId);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const isVideo = relativePath !== null && isWorkspaceVideoPreviewPath(relativePath);
  const isAudio = relativePath !== null && !isVideo && isWorkspaceAudioPreviewPath(relativePath);
  const isImage = relativePath !== null && !isVideo && isWorkspaceImagePreviewPath(relativePath);
  const isMedia = isImage || isVideo || isAudio;
  const isPdf = relativePath !== null && isPdfPreviewFile(relativePath);
  const isDocument =
    relativePath !== null &&
    (binaryPreviewKind({ name: relativePath }) !== null ||
      officePreviewKind({ name: relativePath }) !== null ||
      isWorkspaceFontPreviewPath(relativePath));
  const isHtml = relativePath !== null && !isPdf && isBrowserPreviewFile(relativePath);
  const isHostFile =
    attachment !== undefined || (relativePath !== null && isHostPath(relativePath));
  const fileAccess = useFilesystemReadAccess(environmentId);
  const { canReadFiles } = fileAccess;
  const canWriteFiles = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const file = useProjectFileQuery(
    environmentId,
    cwd,
    relativePath,
    attachment === undefined && relativePath !== null,
  );
  const [fileRefreshRevision, setFileRefreshRevision] = useState(0);
  const attemptedPath = file.readError?.resolvedPath ?? file.readError?.operationPath;
  // Folder links fail file reads; retain mutation refresh to detect conversion to files. Host folders own
  // roots; folderTrail keeps descendants.
  const breadcrumbPath =
    attachment !== undefined ? null : (relativePath ?? (folderTrail === undefined ? null : ""));
  // Reset crumbs when a host trail reaches the workspace root and no longer passes through the current path.
  const breadcrumbTrail =
    breadcrumbPath === null ? null : retainedBreadcrumbTrail(folderTrail, breadcrumbPath);
  // A trail implies a folder before reads settle, preventing file-preview flashes while navigating up.
  const isFolder =
    attachment === undefined &&
    (file.isNotFile || (folderTrail !== undefined && file.data === null && file.error === null));
  const hostFolderPath = isFolder && isHostFile ? relativePath : null;
  // A chat-linked folder reads as a file until its read settles, and revealing a
  // folder selects it in its parent instead of opening it, so reveal waits.
  const revealsInFileManager =
    !isFolder &&
    (file.data !== null || file.error !== null) &&
    serverConfig?.shellRevealInFileManager === true;
  // Everything preview-related keys off previewPath; a folder has no preview.
  const previewPath = isFolder ? null : relativePath;
  // The explorer's open state stays in the file tree store rather than in local
  // state here: the tree and the panel header both read it, and v0.0.42's local
  // copy would be a second one that drifts.
  const explorerOpen = useFileTreeStore((state) => state.explorerOpen);
  const toggleExplorer = useFileTreeStore((state) => state.toggleExplorer);
  const showExplorer =
    !explorerHidden &&
    shouldShowFileExplorer({
      relativePath: previewPath,
      explorerOpen,
      attachmentOpen: attachment !== undefined,
    });
  // Reading markdown rendered is a preference, not a property of one file. Keeping
  // it on the panel meant a thread switch dropped it and forced source back.
  const [renderMarkdownPreferred, setRenderMarkdownPreferred] = useLocalStorage(
    RENDER_MARKDOWN_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const [renderBrowserFilePreferred, setRenderBrowserFilePreferred] = useLocalStorage(
    RENDER_BROWSER_FILE_STORAGE_KEY,
    true,
    Schema.Boolean,
  );
  const [renderTablePreferred, setRenderTablePreferred] = useLocalStorage(
    RENDER_TABLE_STORAGE_KEY,
    true,
    Schema.Boolean,
  );
  // Reveal ids restart at one per file; pair with the path so dismissal cannot swallow another file's reveal.
  const [handledReveal, setHandledReveal] = useState<{ path: string; requestId: number } | null>(
    null,
  );
  /**
   * The file the editor shows, one read behind the selected one. Holding it keeps the editor
   * mounted while the next file is read, with the spinner drawn on top: a spinner *instead of*
   * the editor unmounts it and loses the undo stack, caret and scroll of the file being left.
   */
  const [editorFile, setEditorFile] = useState<{
    readonly relativePath: string;
    readonly contents: string;
  } | null>(null);
  const breadcrumbRef = useRef<HTMLDivElement>(null);
  const isMarkdown = previewPath ? isMarkdownPreviewFile(previewPath) : false;
  const isMermaid = previewPath !== null && /\.(mmd|mermaid)$/i.test(previewPath);
  const [renderMermaidPreferred, setRenderMermaidPreferred] = useLocalStorage(
    "t3code.renderMermaid",
    true,
    Schema.Boolean,
  );
  const tableDelimiter =
    previewPath && attachment === undefined ? filePreviewDelimiter({ name: previewPath }) : null;
  const revealHandled =
    revealLine === null ||
    (handledReveal?.path === relativePath && handledReveal.requestId === revealRequestId);
  const renderMarkdown = isMarkdown && renderMarkdownPreferred && revealHandled;
  const renderMermaid = isMermaid && renderMermaidPreferred && revealHandled;
  const renderBrowserFile = isPdf || (isHtml && renderBrowserFilePreferred && revealHandled);
  const renderTable = tableDelimiter !== null && renderTablePreferred && revealHandled;
  const renderedMode = isMermaid
    ? ("mermaid" as const)
    : isMarkdown
      ? ("markdown" as const)
      : tableDelimiter
        ? ("table" as const)
        : isHtml
          ? ("html" as const)
          : null;
  const canToggleRendered =
    previewPath !== null && attachment === undefined && renderedMode !== null;
  const showsRawText =
    previewPath !== null &&
    file.data !== null &&
    !(isMarkdown && renderMarkdown) &&
    !renderMermaid &&
    !(tableDelimiter && renderTable) &&
    !renderBrowserFile &&
    !isDocument;
  const rendered = isMermaid
    ? renderMermaid
    : isMarkdown
      ? renderMarkdown
      : tableDelimiter
        ? renderTable
        : renderBrowserFile;
  const setRenderedPreferred = isMermaid
    ? setRenderMermaidPreferred
    : isMarkdown
      ? setRenderMarkdownPreferred
      : tableDelimiter
        ? setRenderTablePreferred
        : setRenderBrowserFilePreferred;

  // What the editor may show: a read workspace text file. Media, documents, a
  // rendered view and an over-sized file draw something else, and release it.
  // Mesura: folders and connections without write access never reach it either.
  const editorEligible =
    relativePath !== null &&
    !isFolder &&
    canWriteFiles &&
    !isMedia &&
    !isDocument &&
    !isHostFile &&
    !renderMarkdown &&
    !renderMermaid &&
    !renderBrowserFile;
  const loadedContents =
    editorEligible && file.data !== null && !file.data.truncated ? file.data.contents : null;
  if (!editorEligible && editorFile !== null) {
    setEditorFile(null);
  } else if (
    editorEligible &&
    loadedContents !== null &&
    relativePath !== null &&
    (editorFile?.relativePath !== relativePath || editorFile.contents !== loadedContents)
  ) {
    setEditorFile({ relativePath, contents: loadedContents });
  }

  const canOpenInBrowser =
    canOperatePreview &&
    previewPath !== null &&
    attachment === undefined &&
    !isVideo &&
    previewAvailable &&
    isBrowserPreviewFile(previewPath);
  // Navigating up preserves the file tab; retain the trail's path spelling to find its folder tab.
  const navigateToFolder = (crumbPath: string) => {
    const path =
      breadcrumbTrail !== null && breadcrumbPathOf(breadcrumbTrail) === crumbPath
        ? breadcrumbTrail
        : crumbPath;
    onNavigateFolder(path, retainedBreadcrumbTrail(breadcrumbTrail ?? undefined, path), !isFolder);
  };
  const absolutePath =
    breadcrumbPath === ""
      ? cwd
      : relativePath && attachment === undefined
        ? resolvePathLinkTarget(relativePath, cwd)
        : null;
  const onFilePostRender = useFileLineReveal(relativePath, revealLine, revealRequestId);
  useWorkspaceMutationRefresh({
    enabled:
      attachment === undefined &&
      relativePath !== null &&
      // Skip mutation reads for media and documents; folders still detect conversion to files.
      (isFolder || (!isMedia && !isPdf && !isDocument)) &&
      !selectedFilePending,
    mutationId: workspaceMutationId,
    refresh: file.refresh,
    resourceKey: `file:${environmentId}:${cwd}:${relativePath ?? ""}`,
  });
  // Watches the open file on disk, beside the mutation heuristic above (which also refreshes
  // the tree). Our own save's event arrives while `selectedFilePending` is true and refreshes
  // once the write confirms: one extra read per save, which also shows another writer's
  // change made in that window.
  useProjectFileWatch({
    environmentId,
    cwd,
    relativePath: relativePath !== null && !isMedia ? relativePath : null,
    enabled: relativePath !== null && !isMedia && !selectedFilePending,
    refresh: file.refresh,
  });

  useEffect(() => {
    const crumbs = breadcrumbRef.current?.querySelectorAll<HTMLElement>("[data-file-crumb]");
    // Show the deepest crumb when it fits, but never at the cost of the current one.
    crumbs?.[crumbs.length - 1]?.scrollIntoView({ block: "nearest", inline: "end" });
    breadcrumbRef.current
      ?.querySelector<HTMLElement>("[data-current-file-crumb='true']")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new path or trail re-renders the crumbs, so the current one scrolls back into view.
  }, [breadcrumbPath, breadcrumbTrail]);

  const handleOpenInBrowser = () => {
    if (!canReadFiles || !canOperatePreview || !absolutePath || !environmentHttpBaseUrl) return;
    void (async () => {
      const result = await openFileInPreview({
        threadRef,
        filePath: absolutePath,
        workspaceRoot: cwd,
        httpBaseUrl: environmentHttpBaseUrl,
        createAssetUrl,
        openPreview,
      });
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
        return;
      }
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open file in browser",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    })();
  };

  if (attachment === undefined && !canReadFiles) {
    if (fileAccess.isPending) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Checking file access...
        </div>
      );
    }
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {fileAccess.error ?? "This connection cannot read host files."}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {breadcrumbPath !== null && breadcrumbTrail !== null ? (
        <div className={FILE_SURFACE_SUBHEADER_CLASS} data-surface-subheader>
          <ScrollArea
            radius="none"
            ref={breadcrumbRef}
            hideScrollbars
            scrollFade
            className="min-w-0 flex-1"
            data-file-breadcrumbs
          >
            <div className="flex h-full w-max min-w-full items-center text-xs">
              <FileBreadcrumbs
                cwd={cwd}
                environmentId={environmentId}
                onNavigateFolder={navigateToFolder}
                onOpenFile={onOpenFile}
                projectName={projectName}
                relativePath={breadcrumbPath}
                trail={breadcrumbTrail}
                workspaceMutationId={workspaceMutationId}
              />
            </div>
          </ScrollArea>
          {absolutePath &&
          (environmentId === primaryEnvironmentId || remoteOpenState.mode !== "local-exec") ? (
            <OpenInPicker
              environmentId={environmentId}
              keybindings={keybindings}
              availableEditors={availableEditors}
              enableShortcut={openInShortcutEnabled}
              openInCwd={absolutePath}
              openInCwdIsFile={file.isFile}
              compact
              revealFileManager={revealsInFileManager}
            />
          ) : null}
          {canToggleRendered && renderedMode ? (
            <FileSurfaceAction
              label={renderedToggleLabel(renderedMode, rendered)}
              pressed={rendered}
              onPress={() => {
                const pressed = !rendered;
                setRenderedPreferred(pressed);
                setHandledReveal(
                  pressed && relativePath !== null
                    ? { path: relativePath, requestId: revealRequestId }
                    : null,
                );
              }}
            >
              <MorphIcon
                className="size-3.5"
                icon={rendered ? Code2 : renderedMode === "table" ? Table2 : Eye}
              />
            </FileSurfaceAction>
          ) : null}
          {showsRawText ? (
            <FileSurfaceAction
              label={wordWrap ? "Disable word wrap" : "Enable word wrap"}
              pressed={wordWrap}
              onPress={() => updateClientSettings({ wordWrap: !wordWrap })}
            >
              <WrapTextIcon className="size-3.5" />
            </FileSurfaceAction>
          ) : null}
          {canOpenInBrowser ? (
            <FileSurfaceAction label="Open file in preview browser" onPress={handleOpenInBrowser}>
              <Globe2 className="size-3.5" />
            </FileSurfaceAction>
          ) : null}
          {!isHostFile && previewPath !== null ? (
            <FileSurfaceAction
              label={showExplorer ? "Hide file explorer" : "Show file explorer"}
              pressed={showExplorer}
              onPress={() => {
                // A tab opened without the explorer brings it back, open.
                if (explorerHidden) {
                  if (!explorerOpen) toggleExplorer();
                  onRevealExplorer?.();
                  return;
                }
                toggleExplorer();
              }}
            >
              <FolderTree className="size-3.5" />
            </FileSurfaceAction>
          ) : null}
        </div>
      ) : null}
      {relativePath && !attachment && !isHostFile && !canWriteFiles && !fileAccess.isPending ? (
        <div className="shrink-0 border-b px-3 py-1.5 text-2xs text-muted-foreground">
          Read-only connection. Unsaved edits are kept until write access returns.
        </div>
      ) : null}
      {previewPath &&
      attachment === undefined &&
      !isMedia &&
      !renderBrowserFile &&
      file.data?.truncated &&
      (draft || isMarkdown || isMermaid || isHtml) ? (
        <div className="shrink-0 border-b border-warning/20 bg-warning-surface px-3 py-1.5 text-2xs text-warning-foreground">
          Preview limited to the first 1 MB of a {file.data.byteLength.toLocaleString()} byte file.
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className={cn(
            // `relative` positions the reading spinner over the editor rather than in
            // place of it.
            "relative min-w-0 flex-1 flex-col overflow-hidden",
            previewPath ? "flex" : "hidden",
          )}
        >
          {isFolder ? null : relativePath && attachment ? (
            <AttachmentFilePreview
              key={`${environmentId}:${attachment.id}`}
              name={attachment.name}
              mimeType={attachment.mimeType}
              sizeBytes={attachment.sizeBytes}
              asset={{ environmentId, attachmentId: attachment.id }}
              htmlRender={attachment.htmlRender === true}
              threadRef={threadRef}
            />
          ) : relativePath && isVideo && absolutePath ? (
            <WorkspaceVideoPreview
              key={`${environmentId}:${threadRef.threadId}:${absolutePath}`}
              environmentId={environmentId}
              threadRef={threadRef}
              draft={draft}
              absolutePath={absolutePath}
              workspaceRoot={cwd}
              name={relativePath}
              workspaceMutationId={workspaceMutationId}
            />
          ) : relativePath && isAudio && absolutePath ? (
            <WorkspaceAudioPreview
              key={`${environmentId}:${threadRef.threadId}:${absolutePath}`}
              environmentId={environmentId}
              threadRef={threadRef}
              draft={draft}
              absolutePath={absolutePath}
              workspaceRoot={cwd}
              name={relativePath}
              workspaceMutationId={workspaceMutationId}
            />
          ) : relativePath && isImage && absolutePath ? (
            <WorkspaceImagePreview
              key={absolutePath}
              environmentId={environmentId}
              threadRef={threadRef}
              draft={draft}
              absolutePath={absolutePath}
              workspaceRoot={cwd}
              alt={relativePath}
              workspaceMutationId={workspaceMutationId}
            />
          ) : relativePath && renderBrowserFile && absolutePath ? (
            <WorkspaceBrowserPreview
              key={absolutePath}
              environmentId={environmentId}
              threadRef={threadRef}
              draft={draft}
              absolutePath={absolutePath}
              workspaceRoot={cwd}
              title={relativePath}
              workspaceMutationId={workspaceMutationId}
            />
          ) : relativePath &&
            absolutePath &&
            file.data?.truncated &&
            !isDocument &&
            !draft &&
            !isMarkdown &&
            !isMermaid &&
            !isHtml ? (
            <WorkspaceLargeTextPreview
              key={`${absolutePath}:${renderTable}:${fileRefreshRevision}`}
              environmentId={environmentId}
              threadRef={threadRef}
              absolutePath={absolutePath}
              name={relativePath}
              delimiter={renderTable ? tableDelimiter : null}
              workspaceMutationId={workspaceMutationId}
              revealLine={revealLine}
              revealRequestId={revealRequestId}
            />
          ) : relativePath &&
            absolutePath &&
            (isDocument || file.readError?.failure === "binary_file") ? (
            <AttachmentFilePreview
              key={`${environmentId}:${absolutePath}:${workspaceMutationId}:${fileRefreshRevision}`}
              name={relativePath.split(/[\\/]/).at(-1) || relativePath}
              mimeType="application/octet-stream"
              sizeBytes={0}
              asset={{
                environmentId,
                resource:
                  draft && isDocument
                    ? { _tag: "draft-workspace-file", cwd, path: absolutePath }
                    : {
                        _tag: "media-file",
                        threadId: threadRef.threadId,
                        path: absolutePath,
                        ...(isDocument ? {} : { disposition: "attachment" as const }),
                      },
              }}
              origin="File"
            />
          ) : relativePath && file.error && file.data === null ? (
            <div
              role="alert"
              className="scrollbar-gutter-both flex min-h-0 flex-1 flex-col overflow-auto"
            >
              <div className="my-auto flex shrink-0 flex-col gap-3 px-6 py-6 text-center text-xs leading-relaxed">
                <p className="text-destructive">
                  {file.readError ? filePreviewReadErrorMessage(file.readError) : file.error}
                </p>
                {attemptedPath ? (
                  <p className="text-muted-foreground">
                    Attempted path
                    <code className="block break-all font-mono text-foreground select-all">
                      {attemptedPath}
                    </code>
                  </p>
                ) : null}
                {!isHostFile ? (
                  <p className="text-muted-foreground">
                    Workspace folder:{" "}
                    <code className="break-all font-mono select-all">
                      {file.readError?.cwd ?? cwd}
                    </code>
                    . Check the link's path or locate the file in Files.
                  </p>
                ) : null}
              </div>
            </div>
          ) : relativePath && file.data === null && editorFile === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
              <Spinner size="lg" />
            </div>
          ) : relativePath && (file.data || editorFile) ? (
            file.data && renderMermaid ? (
              <Suspense fallback={<FileSurfaceLoading />}>
                <MermaidFilePreview text={file.data.contents} />
              </Suspense>
            ) : file.data && isMarkdown && renderMarkdown ? (
              <RenderedMarkdownSurface
                key={relativePath}
                environmentId={environmentId}
                cwd={cwd}
                relativePath={relativePath}
                threadRef={threadRef}
                contents={file.data.contents}
                workspaceMutationId={workspaceMutationId}
                readOnly={isHostFile || !canWriteFiles}
                onPendingChange={onPendingChange}
              />
            ) : file.data && tableDelimiter && renderTable ? (
              <DelimitedTablePreview
                key={relativePath}
                name={relativePath}
                text={file.data.contents}
                delimiter={tableDelimiter}
              />
            ) : file.data && (file.data.truncated || isHostFile || !canWriteFiles) ? (
              <SourceFilePreview
                name={relativePath}
                text={file.data.contents}
                cacheKey={projectFileCacheKey(cwd, relativePath, file.data.contents)}
                onPostRender={onFilePostRender}
              />
            ) : editorFile ? (
              <>
                {/*
                 * No key, deliberately: any key remounts the surface, which rebuilds Monaco and
                 * loses the undo stack (`tests/unit/monaco-file-surface-wired.test.ts`). Monaco
                 * owns this slot over upstream's Pierre `EditableFileSurface` because modal
                 * editing and the Neovim config need it; its inline review comments are not carried.
                 */}
                <MonacoFileSurface
                  environmentId={environmentId}
                  cwd={cwd}
                  relativePath={editorFile.relativePath}
                  contents={editorFile.contents}
                  resolvedTheme={resolvedTheme}
                  wordWrap={wordWrap}
                  // A reveal belongs to the file that was asked for. While the
                  // editor is still showing the previous one, it has nothing to
                  // reveal.
                  revealLine={editorFile.relativePath === relativePath ? revealLine : null}
                  revealRequestId={revealRequestId}
                  retention={retention}
                  models={models}
                  composerDraftTarget={composerDraftTarget}
                  threadRef={threadRef}
                  modalEditing={modalEditing}
                  onPendingChange={onPendingChange}
                />
                {file.data === null ? (
                  <div
                    className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/40 text-muted-foreground"
                    aria-hidden="true"
                  >
                    <Spinner size="lg" />
                  </div>
                ) : null}
              </>
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
                <Spinner size="lg" />
              </div>
            )
          ) : null}
        </div>
        {showExplorer ? (
          <aside
            className={cn(
              "flex min-h-0 shrink-0 bg-background",
              previewPath
                ? "w-[min(22rem,46%)] min-w-64 border-l border-border/60"
                : "min-w-0 flex-1",
            )}
          >
            <MesuraFileTree
              key={`${environmentId}:${hostFolderPath ?? cwd}`}
              environmentId={environmentId}
              cwd={hostFolderPath ?? cwd}
              projectName={hostFolderPath ?? projectName}
              selectedPath={
                hostFolderPath === null
                  ? relativePath
                  : trailChildOf(hostFolderPath, breadcrumbTrail ?? hostFolderPath)
              }
              selectedPathRevealId={revealRequestId}
              onOpenFile={(path) =>
                onOpenFile(hostFolderPath === null ? path : joinPath(hostFolderPath, path))
              }
              workspaceMutationId={workspaceMutationId}
              {...(previewPath && !isMedia && !isPdf
                ? {
                    onRefreshSelectedFile: () => {
                      if (!isDocument) file.refresh();
                      setFileRefreshRevision((value) => value + 1);
                    },
                  }
                : {})}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}

const LargeTextViewer = lazy(() => import("./LargeTextViewer"));
export function WorkspaceLargeTextPreview(props: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  absolutePath: string;
  name: string;
  delimiter: "," | "\t" | null;
  workspaceMutationId: string | null;
  revealLine: number | null;
  revealRequestId: number;
}) {
  const resource = {
    _tag: "media-file",
    threadId: props.threadRef.threadId,
    path: props.absolutePath,
    disposition: "attachment",
  } as const;
  const copyContents = useRef<(() => Promise<string>) | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: props.name });
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  const showError = (cause: unknown) => {
    toastManager.add({
      type: "error",
      title: "Could not read file",
      description: cause instanceof Error ? cause.message : "Try again.",
    });
  };
  const assetUrl = useAssetUrlState(props.environmentId, resource);
  const refreshAssetUrl = useAssetUrlRefresh(props.environmentId, resource);
  useWorkspaceMutationRefresh({
    mutationId: props.workspaceMutationId,
    resourceKey: JSON.stringify([props.environmentId, resource]),
    refresh: () => {
      void refreshAssetUrl().catch(() => undefined);
    },
  });
  const contentRevision = JSON.stringify([
    props.environmentId,
    resource,
    assetUrl._tag === "Success" ? (assetUrl.fileRevision ?? props.workspaceMutationId) : null,
    revision,
  ]);
  const [loaded, setLoaded] = useState<{ revision: string; url: string } | null>(null);
  if (assetUrl._tag === "Success" && loaded?.revision !== contentRevision) {
    setLoaded({ revision: contentRevision, url: assetUrl.url });
  }
  if (assetUrl._tag === "Failure")
    return (
      <FileSurfaceFailure
        message="Unable to load file preview."
        onRetry={() => {
          setRevision((value) => value + 1);
          void refreshAssetUrl().catch(showError);
        }}
      />
    );
  if (assetUrl._tag !== "Success" || loaded === null)
    return <div className="p-6 text-xs text-muted-foreground">Loading…</div>;
  const src = `${loaded.url}${loaded.url.includes("?") ? "&" : "?"}revision=${encodeURIComponent(loaded.revision)}`;
  return (
    <>
      <div className={FILE_SURFACE_SUBHEADER_CLASS}>
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">Full file</span>
        <FileSurfaceAction
          label={isCopied ? "Copied" : "Copy contents"}
          onPress={() => {
            const copy = copyContents.current;
            if (!copy) return;
            void copy()
              .then((text) => copyToClipboard(text, undefined))
              .catch(showError);
          }}
        >
          {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
        </FileSurfaceAction>
        <FileSurfaceAction
          label={saving ? "Preparing file…" : "Save file"}
          disabled={saving}
          onPress={() => {
            setSaving(true);
            void (async () => {
              const url = await refreshAssetUrl();
              if (!url) throw new Error("Reconnect to the environment and try again.");
              const response = await fetch(url);
              if (!response.ok) throw new Error("The file could not be loaded. Try again.");
              const downloadUrl = URL.createObjectURL(await response.blob());
              setTimeout(() => URL.revokeObjectURL(downloadUrl), 30_000);
              const anchor = document.createElement("a");
              anchor.href = downloadUrl;
              anchor.download = props.name.split(/[\\/]/).at(-1) || props.name;
              anchor.click();
            })()
              .catch(showError)
              .finally(() => setSaving(false));
          }}
        >
          <DownloadIcon className="size-3.5" />
        </FileSurfaceAction>
      </div>
      <Suspense fallback={<div className="p-6 text-xs text-muted-foreground">Loading…</div>}>
        <LargeTextViewer
          key={`${src}:${revision}`}
          name={props.name}
          copyContents={copyContents}
          onRetry={() => {
            void refreshAssetUrl()
              .then(() => setRevision((value) => value + 1))
              .catch(showError);
          }}
          src={src}
          delimiter={props.delimiter}
          revealLine={props.revealLine}
          revealRequestId={props.revealRequestId}
        />
      </Suspense>
    </>
  );
}
