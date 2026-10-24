import { lazy, Suspense, type ComponentProps } from "react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { FactoryTimelineItem } from "@t3tools/client-runtime/factory/plan-activities";
import { RightPanelSurfaceContent } from "./RightPanelSurfaceContent";
import { ThreadIssuesPanel } from "../issues/ThreadIssuesPanel";
import { issuesSurfaceProject } from "../../lib/openIssueLink";
import { useRightPanelStore } from "../../rightPanelStore";

const FactoryPane = lazy(() => import("../../factory/FactoryPane"));
const FilePreviewPanel = lazy(() => import("../files/FilePreviewPanel"));
const DiffPanel = lazy(() => import("../DiffPanel"));

/** Fork-only surfaces and editor state compose with upstream's surface renderer. */
export function MesuraRightPanelSurfaceContent(
  props: ComponentProps<typeof RightPanelSurfaceContent> & {
    readonly activeProject: EnvironmentProject | null;
    readonly projects: ReadonlyArray<EnvironmentProject>;
    readonly pendingProjectKey: string | null;
    readonly factoryItems: ReadonlyArray<FactoryTimelineItem>;
    readonly latestFactoryRunId: string | null;
    readonly initialGitScope: "branch" | "unstaged";
    readonly diffModeMenuRequestId: number;
  },
) {
  const { surface, threadRef, files } = props;
  if (!surface) return null;
  if (surface.kind === "issues") {
    const selectedProject = surface.selection
      ? issuesSurfaceProject({
          selection: surface.selection,
          environmentId: threadRef.environmentId,
          projects: props.projects,
          activeProject: props.activeProject,
        })
      : null;
    const project = selectedProject ?? props.activeProject;
    return project ? (
      <ThreadIssuesPanel
        project={project}
        selection={selectedProject ? surface.selection : undefined}
        onSelectionConsumed={(requestId) =>
          useRightPanelStore.getState().consumeIssueSelection(threadRef, requestId)
        }
      />
    ) : null;
  }
  if (surface.kind === "factory")
    return (
      <Suspense fallback={null}>
        <FactoryPane
          surface={surface}
          factoryItems={props.factoryItems}
          latestRunId={props.latestFactoryRunId}
          threadRef={threadRef}
          visible={props.visible}
          cwd={files.workspaceRoot}
        />
      </Suspense>
    );
  if (surface.kind === "diff")
    return (
      <Suspense fallback={null}>
        <DiffPanel
          key={`${scopedThreadKey(threadRef)}:${props.initialGitScope}`}
          mode="embedded"
          composerDraftTarget={props.composerDraftTarget}
          workspaceMutationId={props.workspaceMutationId}
          initialGitScope={props.initialGitScope}
          modeMenuRequestId={props.diffModeMenuRequestId}
          visible={props.visible}
        />
      </Suspense>
    );
  if (surface.kind === "file" || surface.kind === "files") {
    const attachment = surface.kind === "file" ? surface.attachment : undefined;
    if (!attachment && (files.projectName === null || !files.workspaceRoot)) return null;
    return (
      <Suspense fallback={null}>
        <FilePreviewPanel
          key={`${props.environmentId}:${attachment ? `attachment:${attachment.id}` : files.workspaceRoot}`}
          environmentId={props.environmentId}
          cwd={files.workspaceRoot ?? ""}
          projectName={files.projectName ?? ""}
          threadRef={threadRef}
          composerDraftTarget={props.composerDraftTarget}
          keybindings={props.keybindings}
          availableEditors={files.availableEditors}
          openInShortcutEnabled={props.visible}
          relativePath={surface.kind === "file" ? surface.relativePath : null}
          {...(attachment ? { attachment } : {})}
          revealLine={surface.kind === "file" ? (surface.revealLine ?? null) : null}
          revealRequestId={surface.kind === "file" ? surface.revealRequestId : 0}
          onOpenFile={files.onOpenFile}
          onPendingChange={files.onPendingChange}
          onNavigateFolder={(path, folderTrail, keepSource) =>
            useRightPanelStore
              .getState()
              .navigateFolder(threadRef, surface.id, path, folderTrail, keepSource)
          }
          folderTrail={surface.folderTrail}
          pendingProjectKey={props.pendingProjectKey}
          explorerHidden={surface.kind === "file" && surface.explorerHidden === true}
          onRevealExplorer={() =>
            useRightPanelStore.getState().revealFileExplorer(threadRef, surface.id)
          }
          workspaceMutationId={props.workspaceMutationId}
        />
      </Suspense>
    );
  }
  return <RightPanelSurfaceContent {...props} />;
}
