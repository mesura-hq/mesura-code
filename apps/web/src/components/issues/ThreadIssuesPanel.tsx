import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useCallback, useState } from "react";

import { IssuesPage } from "./IssuesPage";
import { parseIssueSearch, type IssueSearch } from "./issues.logic";

export function ThreadIssuesPanel({ project }: { project: EnvironmentProject }) {
  // Filters and the selected issue belong to one project: when the pane is handed another one,
  // they start over, so an issue number can never be read from the wrong repository.
  const projectKey = scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
  const [state, setState] = useState(() => ({ projectKey, search: parseIssueSearch({}) }));
  const search = state.projectKey === projectKey ? state.search : parseIssueSearch({});
  const onSearchChange = useCallback(
    (patch: Partial<IssueSearch>) => {
      setState((current) => ({
        projectKey,
        search: {
          ...(current.projectKey === projectKey ? current.search : parseIssueSearch({})),
          ...patch,
        },
      }));
    },
    [projectKey],
  );

  return <IssuesPage search={search} onSearchChange={onSearchChange} project={project} embedded />;
}
