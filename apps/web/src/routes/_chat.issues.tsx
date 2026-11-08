import { createFileRoute } from "@tanstack/react-router";

import { IssuesPage } from "../components/issues/IssuesPage";
import { parseIssueSearch } from "../components/issues/issues.logic";

export const Route = createFileRoute("/_chat/issues")({
  validateSearch: parseIssueSearch,
  component: IssuesRoute,
});

function IssuesRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <IssuesPage
      search={search}
      onSearchChange={(patch, replace = false) => {
        void navigate({ search: { ...search, ...patch }, replace });
      }}
    />
  );
}
