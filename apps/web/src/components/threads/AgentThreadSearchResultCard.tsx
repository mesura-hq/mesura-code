import type { AgentThreadSearchMatch } from "@t3tools/client-runtime/state/agent-thread-search";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { FolderGit2Icon, FolderIcon } from "lucide-react";

import { useThreadShell } from "~/state/entities";

import type { ProjectFaviconProject } from "../ProjectFavicon";
import {
  SidebarThreadCardContent,
  SidebarThreadCardFooter,
  SidebarThreadCardHeader,
  SidebarThreadCardProject,
  SidebarThreadCardReason,
  SidebarThreadCardTitle,
  sidebarThreadTimeLabel,
} from "../SidebarThreadCardContent";

/** Shows a search match with the same card content as a sidebar thread. */
export function AgentThreadSearchResultCard(props: {
  readonly match: AgentThreadSearchMatch;
  readonly project: ProjectFaviconProject | null;
}) {
  const { match, project } = props;
  const thread = useThreadShell(scopeThreadRef(match.environmentId, match.threadId));
  const archivedAt = thread === null ? match.archivedAt : thread.archivedAt;
  return (
    <SidebarThreadCardContent surface="search">
      <SidebarThreadCardHeader>
        <SidebarThreadCardProject project={project} label={match.projectTitle} />
        {archivedAt !== null ? (
          <span className="text-xs text-secondary-label">Archived</span>
        ) : thread !== null ? (
          <span className="text-xs text-secondary-label tabular-nums">
            {sidebarThreadTimeLabel(thread)}
          </span>
        ) : null}
      </SidebarThreadCardHeader>
      <SidebarThreadCardTitle>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/90">
          {match.threadTitle}
        </span>
      </SidebarThreadCardTitle>
      <SidebarThreadCardFooter>
        {thread?.branch ? (
          <>
            {thread.worktreePath ? (
              <FolderGit2Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/40" />
            ) : (
              <FolderIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/40" />
            )}
            <span className="min-w-0 flex-1 truncate whitespace-nowrap text-muted-foreground/40">
              {thread.branch}
            </span>
          </>
        ) : (
          <span className="flex-1" />
        )}
        <span className="shrink-0 text-secondary-label">{match.environmentLabel}</span>
      </SidebarThreadCardFooter>
      <SidebarThreadCardReason>{match.reason}</SidebarThreadCardReason>
    </SidebarThreadCardContent>
  );
}
