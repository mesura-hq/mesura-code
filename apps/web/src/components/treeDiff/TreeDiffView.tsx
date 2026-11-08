/**
 * Fork addition: the Diff surface's Tree diff mode, a port of Symmetria IDE's Active Changes
 * panel. It answers "what is uncommitted right now, and where does it live": the branch and side
 * summary over a tree of changed files, each opening in its own tab. The IDE's diff beside the
 * tree is left out for now.
 */
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { GitBranchIcon } from "lucide-react";
import type { ReactNode } from "react";

import { RefreshIcon } from "~/components/ui/refresh-icon";
import { cn } from "~/lib/utils";

import { DiffPanelLoadingState } from "../DiffPanelShell";
import { DiffFileTree } from "../diffs/DiffFileTree";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { treeDiffErrorMessage } from "./treeDiff.logic";
import { TreeDiffSummary } from "./TreeDiffSummary";
import { openGitChangeFile, useWorkingTreeChanges } from "./useWorkingTreeChanges";

export interface TreeDiffViewProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly threadRef: ScopedThreadRef;
}

export function TreeDiffView(props: TreeDiffViewProps) {
  const changes = useWorkingTreeChanges({
    environmentId: props.environmentId,
    cwd: props.cwd,
  });

  const refreshButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Refresh tree diff"
            onClick={changes.refresh}
          />
        }
      >
        <RefreshIcon size="sm" refreshing={changes.isPending} />
      </TooltipTrigger>
      <TooltipPopup>Refresh</TooltipPopup>
    </Tooltip>
  );

  // A failed refresh keeps the last result on screen and says why it is not newer.
  const refreshError = changes.refreshError ? (
    <p role="alert" className="mt-1 text-search-label text-error/80">
      Refresh failed: {treeDiffErrorMessage(changes.refreshError)}
    </p>
  ) : null;

  if (!changes.isRepo) {
    return <ViewMessage>This project is not a git repository.</ViewMessage>;
  }
  if (!changes.hasLoaded) {
    return changes.error ? (
      <ViewMessage tone="error">{treeDiffErrorMessage(changes.error)}</ViewMessage>
    ) : (
      <DiffPanelLoadingState label="Loading tree diff..." />
    );
  }
  if (changes.rows.length === 0) {
    // The resting state, not an error: everything is committed.
    return (
      <ViewMessage>
        <span className="flex flex-col items-center">
          <span className="flex items-center gap-1">
            Working tree clean
            {refreshButton}
          </span>
          {refreshError}
        </span>
      </ViewMessage>
    );
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="shrink-0 px-3 pt-1 pb-2">
        {changes.refName ? (
          <div className="mb-1 flex min-w-0 items-center gap-1 text-search-label text-muted-foreground">
            <GitBranchIcon className="size-3 shrink-0" />
            <span className="truncate">{changes.refName}</span>
          </div>
        ) : null}
        <TreeDiffSummary summary={changes.summary} />
        {refreshError}
        {changes.truncated ? (
          <p className="mt-1 text-search-label text-warning">
            Showing the first {changes.rows.length} files.
          </p>
        ) : null}
      </div>
      <DiffFileTree
        ariaLabel="Changed files"
        title="Files"
        entries={changes.treeEntries}
        renderFileDecoration={changes.renderFileDecoration}
        headerAccessory={refreshButton}
        onSelectFile={(path) => openGitChangeFile(props.threadRef, changes.rowsByPath, path)}
      />
    </div>
  );
}

function ViewMessage(props: { children: ReactNode; tone?: "error" }) {
  return (
    <div
      className={cn(
        "flex flex-1 items-center justify-center px-5 text-center text-xs",
        props.tone === "error" ? "text-error/80" : "text-muted-foreground/70",
      )}
    >
      {props.children}
    </div>
  );
}
