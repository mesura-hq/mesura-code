import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useCallback, useEffect, useState } from "react";

import { IssuesPage } from "./IssuesPage";
import { parseIssueSearch, type IssueSearch } from "./issues.logic";

export function ThreadIssuesPanel({
  project,
  selection,
  onSelectionConsumed,
}: {
  project: EnvironmentProject;
  /**
   * An issue chosen from a message reference. Each `requestId` opens its issue once; a consumed
   * one has already been shown, so the pane opens on the list instead.
   */
  selection?:
    | { readonly number: number; readonly requestId: number; readonly consumed?: boolean }
    | undefined;
  /** Records that the pane showed `requestId`, so remounting it after Back keeps the list. */
  onSelectionConsumed?: ((requestId: number) => void) | undefined;
}) {
  // Filters and the selected issue belong to one project: when the pane is handed another one,
  // they start over, so an issue number can never be read from the wrong repository.
  const projectKey = scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
  const pending = selection !== undefined && selection.consumed !== true ? selection : undefined;
  const [state, setState] = useState<{
    projectKey: string;
    search: IssueSearch;
    consumedRequestId: number | null;
  }>(() => ({
    projectKey,
    search: { ...parseIssueSearch({}), issue: pending?.number },
    consumedRequestId: selection?.requestId ?? null,
  }));
  const currentSearch = state.projectKey === projectKey ? state.search : parseIssueSearch({});
  // A new choice opens its issue once; going Back afterwards keeps the list until the next one.
  // The detail reads by number, so filters left in the list never hold it back.
  if (pending !== undefined && pending.requestId !== state.consumedRequestId) {
    setState({
      projectKey,
      search: { ...currentSearch, issue: pending.number },
      consumedRequestId: pending.requestId,
    });
  }
  const shownRequestId =
    pending !== undefined && pending.requestId === state.consumedRequestId
      ? pending.requestId
      : null;
  useEffect(() => {
    if (shownRequestId !== null) onSelectionConsumed?.(shownRequestId);
  }, [onSelectionConsumed, shownRequestId]);
  const onSearchChange = useCallback(
    (patch: Partial<IssueSearch>) => {
      setState((current) => ({
        ...current,
        projectKey,
        search: {
          ...(current.projectKey === projectKey ? current.search : parseIssueSearch({})),
          ...patch,
        },
      }));
    },
    [projectKey],
  );

  return (
    <IssuesPage search={currentSearch} onSearchChange={onSearchChange} project={project} embedded />
  );
}
