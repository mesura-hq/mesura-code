import { Spinner } from "~/components/ui/spinner";
import type {
  ChatFileAttachment,
  EditorId,
  EnvironmentId,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { filePreviewDelimiter } from "@t3tools/shared/delimitedPreview";
import {
  isWorkspaceAudioPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspaceVideoPreviewPath,
} from "@t3tools/shared/filePreview";
import { VirtualizedFile } from "@pierre/diffs";
import { type FileOptions } from "@pierre/diffs/react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { mediaFileReference } from "@t3tools/client-runtime/media-reference";
import { Code2, Eye, FolderTree, Globe2, Table2, WrapTextIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isBrowserPreviewFile, openFileInPreview } from "~/browser/openFileInPreview";
import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { OpenInPicker } from "~/components/chat/OpenInPicker";
import { MediaVideoPlayer } from "~/components/media/MediaVideoPlayer";
import { MediaActions, type MediaActionSource } from "~/components/media/MediaActions";
import { useRemoteOpenState } from "~/remoteOpen";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { cn } from "~/lib/utils";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { isAbsolutePath, resolvePathLinkTarget } from "~/terminal-links";
import { ScrollArea } from "~/components/ui/scroll-area";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { type DraftId } from "~/composerDraftStore";
import { assetEnvironment } from "~/state/assets";
import { useEnvironmentHttpBaseUrl, usePrimaryEnvironmentId } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { useFileTreeStore } from "./mesuraTree/fileTreeStore";
import { MesuraFileTree } from "./mesuraTree/MesuraFileTree";
import { AttachmentFilePreview } from "./AttachmentFilePreview";
import { AudioPreview } from "./AudioPreview";
import { BrowserDocumentFrame, isPdfPreviewFile } from "./BrowserDocumentFrame";
import { DelimitedTablePreview } from "./DelimitedTablePreview";
import { FileBreadcrumbs } from "./FileBreadcrumbs";
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
  isMarkdownPreviewFile,
  setMarkdownTaskChecked,
  shouldShowFileExplorer,
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
  revealLine: number | null;
  revealRequestId: number;
  onOpenFile: (relativePath: string) => void;
  onPendingChange: (relativePath: string, pending: boolean) => void;
  selectedFilePending: boolean;
  workspaceMutationId: string | null;
}

const RENDER_MARKDOWN_STORAGE_KEY = "t3code.renderMarkdown";
const RENDER_BROWSER_FILE_STORAGE_KEY = "t3code.renderBrowserFile";
const RENDER_TABLE_STORAGE_KEY = "t3code.renderTable";
type FilePostRender = NonNullable<FileOptions<unknown>["onPostRender"]>;

function WorkspaceImagePreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly alt: string;
  readonly workspaceMutationId: string | null;
}) {
  const resource = useMemo(
    () => ({
      _tag: "workspace-file" as const,
      threadId: props.threadRef.threadId,
      path: props.absolutePath,
    }),
    [props.threadRef.threadId, props.absolutePath],
  );
  const assetUrl = useAssetUrlState(props.environmentId, resource);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
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

  if (assetUrl._tag === "Failure" || (imageUrl !== null && failedUrl === imageUrl)) {
    return (
      <MediaActions source={actionsSource}>
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
          Unable to load workspace image.
        </div>
      </MediaActions>
    );
  }

  return assetUrl._tag === "Success" && imageUrl !== null ? (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <MediaActions source={actionsSource}>
        <img
          className="max-h-full max-w-full object-contain"
          src={imageUrl}
          alt={props.alt}
          onError={() => setFailedUrl(imageUrl)}
        />
      </MediaActions>
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
      <Spinner className="size-5" />
    </div>
  );
}

/**
 * Renders an HTML or PDF file in place from its signed asset URL. HTML runs in
 * a sandboxed frame with an opaque origin, so a page cannot reach the app's
 * session or storage. A file inside the workspace may load sibling assets; a
 * host file outside it is served on its own.
 */
function WorkspaceBrowserPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly title: string;
  readonly workspaceMutationId: string | null;
}) {
  const insideWorkspace =
    mediaFileReference(props.absolutePath, props.workspaceRoot).relativePath !== undefined;
  const resource = useMemo(
    () => ({
      _tag: insideWorkspace ? ("workspace-file" as const) : ("media-file" as const),
      threadId: props.threadRef.threadId,
      path: props.absolutePath,
    }),
    [insideWorkspace, props.threadRef.threadId, props.absolutePath],
  );
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
        <Spinner className="size-5" />
      </div>
    );
  }
  return (
    <BrowserDocumentFrame
      src={`${assetUrl.url}${revisionSuffix}`}
      title={props.title}
      pdf={isPdfPreviewFile(props.absolutePath)}
    />
  );
}

function WorkspaceVideoPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly name: string;
  readonly workspaceMutationId: string | null;
}) {
  const resource = useMemo(
    () => ({
      _tag: "media-file" as const,
      threadId: props.threadRef.threadId,
      path: props.absolutePath,
    }),
    [props.threadRef.threadId, props.absolutePath],
  );
  const assetUrl = useAssetUrlState(props.environmentId, resource);
  const refreshAssetUrl = useAssetUrlRefresh(props.environmentId, resource);
  useWorkspaceMutationRefresh({
    mutationId: props.workspaceMutationId,
    resourceKey: JSON.stringify([props.environmentId, resource]),
    refresh: () => {
      // Failed refreshes flow through assetUrl and can be retried from the player.
      void refreshAssetUrl().catch(() => undefined);
    },
  });
  const revisionSuffix =
    props.workspaceMutationId === null
      ? ""
      : `${assetUrl._tag === "Success" && assetUrl.url.includes("?") ? "&" : "?"}workspace-revision=${encodeURIComponent(props.workspaceMutationId)}`;
  const latestUrl = assetUrl._tag === "Success" ? `${assetUrl.url}${revisionSuffix}` : null;

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
      <MediaVideoPlayer
        src={latestUrl}
        sourceFailed={assetUrl._tag === "Failure"}
        label={props.name}
        revision={props.workspaceMutationId}
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
  readonly absolutePath: string;
  readonly name: string;
  readonly workspaceMutationId: string | null;
}) {
  const resource = useMemo(
    () => ({
      _tag: "media-file" as const,
      threadId: props.threadRef.threadId,
      path: props.absolutePath,
    }),
    [props.threadRef.threadId, props.absolutePath],
  );
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
  const revisionSuffix =
    props.workspaceMutationId === null
      ? ""
      : `${assetUrl._tag === "Success" && assetUrl.url.includes("?") ? "&" : "?"}workspace-revision=${encodeURIComponent(props.workspaceMutationId)}`;
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
  return <AudioPreview src={url} name={props.name} onError={() => setFailedUrl(url)} />;
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

/**
 * Frames to keep retrying while the file contents or line metrics are not
 * available yet (fresh mounts hydrate asynchronously).
 */
const REVEAL_MAX_ATTEMPTS = 30;
/**
 * After scrolling to the target, hold it for a short window so late
 * programmatic scroll resets (editable-editor focus and state restoration)
 * cannot silently snap the file back to the top. Real user input cancels the
 * guard immediately.
 */
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

  return useCallback<FilePostRender>(
    (fileContainer, instance, phase) => {
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
        // Pierre stops gutter pointer events from bubbling. Listen in capture
        // so starting a comment cancels the reveal guard before the row expands.
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

          // Contents and line metrics can lag the first post-render on fresh
          // mounts; clamping against missing contents would scroll to line 1
          // and wrongly mark the request handled.
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
    },
    [revealStatesByPath, relativePath, revealLine, revealRequestId],
  );
}

function RenderedMarkdownSurface({
  environmentId,
  cwd,
  relativePath,
  contents,
  threadRef,
  readOnly,
  onPendingChange,
}: FileSaveCoordinatorInput & {
  contents: string;
  threadRef: ScopedThreadRef;
  readOnly: boolean;
}) {
  const saveCoordinator = useFileSaveCoordinator({
    environmentId,
    cwd,
    relativePath,
    onPendingChange,
  });

  return (
    <ScrollArea className="min-h-0 flex-1">
      <FileMarkdownPreview
        text={contents}
        cwd={cwd}
        relativePath={relativePath}
        threadRef={threadRef}
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

function renderedToggleLabel(mode: "markdown" | "html" | "table", rendered: boolean): string {
  if (mode === "markdown") return rendered ? "Show markdown source" : "Show rendered markdown";
  if (mode === "table") return rendered ? "Show source" : "Show table";
  return rendered ? "Show HTML source" : "Show rendered page";
}

export default function FilePreviewPanel({
  environmentId,
  cwd,
  projectName,
  relativePath,
  attachment,
  threadRef,
  composerDraftTarget,
  keybindings,
  availableEditors,
  revealLine,
  revealRequestId,
  onOpenFile,
  onPendingChange,
  selectedFilePending,
  workspaceMutationId,
}: FilePreviewPanelProps) {
  const { resolvedTheme } = useTheme();
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  const modalEditing = useClientSettings((settings) => settings.modalEditing);
  // Retention outlives every file the panel shows. The editor that reads it
  // The editor's models and the retention record that goes with them.
  //
  // Held by a registry outside React rather than by this panel, because the
  // undo stack lives in the Monaco model and this panel unmounts for three
  // ordinary things: the spinner while a file is read, opening Settings, and
  // switching to a thread in another project. The first was already survived
  // by hoisting the cache here from the surface; the other two are route
  // changes, which no component survives.
  const { models, retention } = useProjectEditorModels(environmentId, cwd);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const remoteOpenState = useRemoteOpenState(environmentId);
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
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
  // PDFs have no text to show; HTML has, and can toggle between page and source.
  const isPdf = relativePath !== null && isPdfPreviewFile(relativePath);
  const isHtml = relativePath !== null && !isPdf && isBrowserPreviewFile(relativePath);
  // A file outside the workspace (an absolute path) is shown, never edited.
  const isHostFile =
    attachment !== undefined || (relativePath !== null && isAbsolutePath(relativePath));
  const file = useProjectFileQuery(
    environmentId,
    cwd,
    relativePath,
    attachment === undefined && !isMedia && !isPdf,
  );
  // The explorer's open state stays in the file tree store rather than in local
  // state here: the tree and the panel header both read it, and v0.0.42's local
  // copy would be a second one that drifts.
  const explorerOpen = useFileTreeStore((state) => state.explorerOpen);
  const toggleExplorer = useFileTreeStore((state) => state.toggleExplorer);
  const showExplorer = shouldShowFileExplorer({
    relativePath,
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
  // Paired with the path on purpose: each file surface counts its reveals from
  // one, so a bare id would let a dismissed reveal on one file swallow the first
  // reveal on the next.
  const [handledReveal, setHandledReveal] = useState<{ path: string; requestId: number } | null>(
    null,
  );
  /**
   * The file the editor is showing, which lags the selected one by a read.
   *
   * Reading a file this client has not seen takes a round trip, and during it
   * the query has no data. Rendering the spinner *instead of* the editor for
   * that moment unmounts it, which throws away the undo stack, the caret and
   * the scroll position of the file being left — so undo never survived a
   * switch, however carefully the editor itself was written.
   *
   * Holding the last loaded file keeps the editor mounted and showing it while
   * the next one is read. The spinner is drawn over the top instead.
   */
  const [editorFile, setEditorFile] = useState<{
    readonly relativePath: string;
    readonly contents: string;
  } | null>(null);
  const breadcrumbRef = useRef<HTMLDivElement>(null);
  const isMarkdown = relativePath ? isMarkdownPreviewFile(relativePath) : false;
  const tableDelimiter =
    relativePath && attachment === undefined ? filePreviewDelimiter({ name: relativePath }) : null;
  // A reveal still wins over the preference: the line only exists in the source.
  const revealHandled =
    revealLine === null ||
    (handledReveal?.path === relativePath && handledReveal.requestId === revealRequestId);
  const renderMarkdown = isMarkdown && renderMarkdownPreferred && revealHandled;
  const renderBrowserFile = isPdf || (isHtml && renderBrowserFilePreferred && revealHandled);
  const renderTable = tableDelimiter !== null && renderTablePreferred && revealHandled;
  const renderedMode = isMarkdown
    ? ("markdown" as const)
    : tableDelimiter
      ? ("table" as const)
      : isHtml
        ? ("html" as const)
        : null;
  const canToggleRendered = attachment === undefined && renderedMode !== null;
  const updateClientSettings = useUpdateClientSettings();
  // Word wrap only reaches the text bodies. A rendered Markdown document, a table and the
  // browser frame all lay themselves out, so the toggle stays hidden rather than inert.
  const showsRawText =
    relativePath !== null &&
    file.data !== null &&
    !(isMarkdown && renderMarkdown) &&
    !(tableDelimiter && renderTable) &&
    !renderBrowserFile;
  const rendered = isMarkdown ? renderMarkdown : tableDelimiter ? renderTable : renderBrowserFile;
  const setRenderedPreferred = isMarkdown
    ? setRenderMarkdownPreferred
    : tableDelimiter
      ? setRenderTablePreferred
      : setRenderBrowserFilePreferred;

  // What the editor is allowed to show: a workspace text file that has been
  // read. Media, a rendered view and an over-sized file all draw something
  // else, so the editor is released rather than held behind them.
  const editorEligible =
    relativePath !== null && !isMedia && !isHostFile && !renderMarkdown && !renderBrowserFile;
  const loadedContents =
    editorEligible && file.data !== null && !file.data.truncated ? file.data.contents : null;
  useEffect(() => {
    if (!editorEligible) {
      setEditorFile(null);
      return;
    }
    if (loadedContents === null || relativePath === null) return;
    setEditorFile((current) =>
      current !== null &&
      current.relativePath === relativePath &&
      current.contents === loadedContents
        ? current
        : { relativePath, contents: loadedContents },
    );
  }, [editorEligible, relativePath, loadedContents]);

  const canOpenInBrowser =
    relativePath !== null &&
    attachment === undefined &&
    !isVideo &&
    isPreviewSupportedInRuntime() &&
    isBrowserPreviewFile(relativePath);
  const absolutePath =
    relativePath && attachment === undefined ? resolvePathLinkTarget(relativePath, cwd) : null;
  const onFilePostRender = useFileLineReveal(relativePath, revealLine, revealRequestId);
  useWorkspaceMutationRefresh({
    enabled:
      attachment === undefined &&
      relativePath !== null &&
      !isMedia &&
      !isPdf &&
      !selectedFilePending,
    mutationId: workspaceMutationId,
    refresh: file.refresh,
    resourceKey: `file:${environmentId}:${cwd}:${relativePath ?? ""}`,
  });
  // Watches the open file on disk. This sits beside the mutation heuristic
  // above rather than replacing it: the heuristic also refreshes the tree, and
  // the refresh button stays as the way out when either is wrong.
  //
  // Our own save produces an event too. It arrives while `selectedFilePending`
  // is true, so it waits and refreshes once the write confirms — one extra read
  // per save, accepted because it is also what makes somebody else's write
  // during that same window visible.
  useProjectFileWatch({
    environmentId,
    cwd,
    relativePath: relativePath !== null && !isMedia ? relativePath : null,
    enabled: relativePath !== null && !isMedia && !selectedFilePending,
    refresh: file.refresh,
  });

  useEffect(() => {
    const currentCrumb = breadcrumbRef.current?.querySelector<HTMLElement>(
      "[data-current-file-crumb='true']",
    );
    currentCrumb?.scrollIntoView({ block: "nearest", inline: "end" });
  }, [relativePath]);

  const handleOpenInBrowser = useCallback(() => {
    if (!absolutePath || !environmentHttpBaseUrl) return;
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
  }, [absolutePath, createAssetUrl, cwd, environmentHttpBaseUrl, openPreview, threadRef]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {relativePath && attachment === undefined ? (
        <div className={FILE_SURFACE_SUBHEADER_CLASS} data-surface-subheader>
          <ScrollArea
            ref={breadcrumbRef}
            hideScrollbars
            scrollFade
            className="min-w-0 flex-1 rounded-none"
            data-file-breadcrumbs
          >
            <div className="flex h-full w-max min-w-full items-center text-xs">
              <FileBreadcrumbs
                cwd={cwd}
                environmentId={environmentId}
                onOpenFile={onOpenFile}
                projectName={projectName}
                relativePath={relativePath}
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
              openInCwd={absolutePath}
              compact
              enableShortcut={false}
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
              {rendered ? (
                <Code2 className="size-3.5" />
              ) : renderedMode === "table" ? (
                <Table2 className="size-3.5" />
              ) : (
                <Eye className="size-3.5" />
              )}
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
          {!isHostFile ? (
            <FileSurfaceAction
              label={explorerOpen ? "Hide file explorer" : "Show file explorer"}
              pressed={explorerOpen}
              onPress={toggleExplorer}
            >
              <FolderTree className="size-3.5" />
            </FileSurfaceAction>
          ) : null}
        </div>
      ) : null}
      {relativePath &&
      attachment === undefined &&
      !isMedia &&
      !renderBrowserFile &&
      file.data?.truncated ? (
        <div className="shrink-0 border-b border-warning/20 bg-warning-surface px-3 py-1.5 text-[11px] text-warning-foreground">
          Preview limited to the first 1 MB of a {file.data.byteLength.toLocaleString()} byte file.
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className={cn(
            // `relative` positions the reading spinner over the editor rather than in
            // place of it.
            "relative min-w-0 flex-1 flex-col overflow-hidden",
            relativePath ? "flex" : "hidden",
          )}
        >
          {relativePath && attachment ? (
            <AttachmentFilePreview
              key={`${environmentId}:${attachment.id}`}
              name={attachment.name}
              mimeType={attachment.mimeType}
              sizeBytes={attachment.sizeBytes}
              asset={{ environmentId, attachmentId: attachment.id }}
            />
          ) : relativePath && isVideo && absolutePath ? (
            <WorkspaceVideoPreview
              key={`${environmentId}:${threadRef.threadId}:${absolutePath}`}
              environmentId={environmentId}
              threadRef={threadRef}
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
              absolutePath={absolutePath}
              name={relativePath}
              workspaceMutationId={workspaceMutationId}
            />
          ) : relativePath && isImage && absolutePath ? (
            <WorkspaceImagePreview
              key={absolutePath}
              environmentId={environmentId}
              threadRef={threadRef}
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
              absolutePath={absolutePath}
              workspaceRoot={cwd}
              title={relativePath}
              workspaceMutationId={workspaceMutationId}
            />
          ) : relativePath && file.error && file.data === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
              {file.error}
            </div>
          ) : relativePath && file.data === null && editorFile === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
              <Spinner className="size-5" />
            </div>
          ) : relativePath && (file.data || editorFile) ? (
            file.data && isMarkdown && renderMarkdown ? (
              // Markdown reconciles in place across text updates, so a file
              // switch needs a new key or the previous file's disclosure and
              // wrap state carries into the next document.
              <RenderedMarkdownSurface
                key={relativePath}
                environmentId={environmentId}
                cwd={cwd}
                relativePath={relativePath}
                threadRef={threadRef}
                contents={file.data.contents}
                readOnly={isHostFile}
                onPendingChange={onPendingChange}
              />
            ) : file.data && tableDelimiter && renderTable ? (
              <DelimitedTablePreview
                key={relativePath}
                name={relativePath}
                text={file.data.contents}
                delimiter={tableDelimiter}
              />
            ) : file.data && (file.data.truncated || isHostFile) ? (
              <SourceFilePreview
                name={relativePath}
                text={file.data.contents}
                cacheKey={projectFileCacheKey(cwd, relativePath, file.data.contents)}
                onPostRender={onFilePostRender}
              />
            ) : editorFile ? (
              <>
                {/*
                 * No key at all, deliberately. A key here — on the path, on the
                 * theme, on anything — remounts the surface, and a remount
                 * rebuilds the Monaco editor and throws away the undo stack.
                 * The surface is told about a new file rather than rebuilt for
                 * one, and it is given the held file rather than the query's,
                 * so it stays mounted while the next file is read.
                 * `tests/unit/monaco-file-surface-wired.test.ts` holds this.
                 *
                 * v0.0.42 put its own Pierre-based `EditableFileSurface` in
                 * this slot, with inline review comments. Monaco owns the slot
                 * here — modal editing and the neovim config depend on it — so
                 * that surface is not carried. Its review-comment flow is the
                 * part worth revisiting.
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
                    <Spinner className="size-5" />
                  </div>
                ) : null}
              </>
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
                <Spinner className="size-5" />
              </div>
            )
          ) : null}
        </div>
        {showExplorer ? (
          <aside
            className={cn(
              "flex min-h-0 shrink-0 bg-background",
              relativePath
                ? "w-[min(22rem,46%)] min-w-64 border-l border-border/60"
                : "min-w-0 flex-1",
            )}
          >
            <MesuraFileTree
              key={`${environmentId}:${cwd}`}
              environmentId={environmentId}
              cwd={cwd}
              projectName={projectName}
              selectedPath={relativePath}
              selectedPathRevealId={revealRequestId}
              onOpenFile={onOpenFile}
              workspaceMutationId={workspaceMutationId}
              {...(relativePath && !isMedia && !isPdf
                ? { onRefreshSelectedFile: file.refresh }
                : {})}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
