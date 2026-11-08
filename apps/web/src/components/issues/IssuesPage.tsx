import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { IssueState, IssueSummary } from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  CircleCheckIcon,
  CircleDotIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useAllEnvironmentShellsBootstrapped, useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { issueDetail, issueList } from "../../state/issues";
import { useEnvironmentQuery } from "../../state/query";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  PullRequestMarkdown,
  PullRequestMarkdownContext,
} from "../pullRequest/PullRequestMarkdown";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { RefreshIcon } from "../ui/refresh-icon";
import {
  projectIssuesAvailability,
  type IssueSearch,
  type ProjectIssuesAvailability,
} from "./issues.logic";

const states: ReadonlyArray<{ value: IssueState; label: string }> = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

function projectKey(project: EnvironmentProject) {
  return scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
}

/** GitHub reports a deleted account as a null author or an empty login; both read as ghost. */
function authorLogin(author: IssueSummary["author"]) {
  return author?.login || "ghost";
}

/** Why a project's issues cannot be read yet, phrased so the reader knows what to do next. */
function unavailableCopy(
  availability: Exclude<ProjectIssuesAvailability, "available">,
  label: string,
  projectTitle: string,
) {
  switch (availability) {
    case "not-github":
      return {
        title: "Issues are not available for this project",
        description: `${projectTitle} is not hosted on GitHub. Issues can only be read from GitHub repositories.`,
      };
    case "unsupported":
      return {
        title: "Issues are not available on this server",
        description: `${label} does not support Issues. Update its Mesura Code server to browse issues here.`,
      };
    case "loading":
      return {
        title: "Checking for Issues support",
        description: `Waiting for ${label} to finish connecting.`,
      };
    case "disconnected":
      return {
        title: "Server not connected",
        description: `${label} is not connected. Issues load once the connection returns.`,
      };
  }
}

function IssueStatus({ state, className }: { state: IssueSummary["state"]; className?: string }) {
  const Icon = state === "OPEN" ? CircleDotIcon : CircleCheckIcon;
  return (
    <Icon
      aria-label={state === "OPEN" ? "Open issue" : "Closed issue"}
      className={cn(
        "size-4 shrink-0",
        state === "OPEN" ? "text-issue-open" : "text-issue-closed",
        className,
      )}
    />
  );
}

function IssueLabels({
  labels,
  onLabel,
}: {
  labels: IssueSummary["labels"];
  onLabel?: (name: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {labels.map((label) => {
        const className =
          "inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-muted/30 px-2 py-0.5 text-search-label text-muted-foreground";
        const content = (
          <>
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{
                backgroundColor: /^[\da-f]{6}$/i.test(label.color)
                  ? `#${label.color}`
                  : "currentColor",
              }}
            />
            {label.name}
          </>
        );
        return onLabel ? (
          <button
            key={label.name}
            type="button"
            className={cn(
              className,
              "min-h-8 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
            )}
            onClick={() => onLabel(label.name)}
          >
            {content}
          </button>
        ) : (
          <span key={label.name} className={className}>
            {content}
          </span>
        );
      })}
    </div>
  );
}

export function IssuesPage({
  search,
  onSearchChange,
  project: fixedProject,
  embedded = false,
}: {
  project?: EnvironmentProject;
  embedded?: boolean;
  search: IssueSearch;
  onSearchChange: (patch: Partial<IssueSearch>, replace?: boolean) => void;
}) {
  const projects = useProjects();
  const projectsKnown = useAllEnvironmentShellsBootstrapped();
  const { environments } = useEnvironments();
  const environmentOf = (candidate: EnvironmentProject) =>
    environments.find((environment) => environment.environmentId === candidate.environmentId) ??
    null;
  const availabilityOf = (candidate: EnvironmentProject) =>
    projectIssuesAvailability(candidate, environmentOf(candidate));
  // A project named in the URL is authoritative: when it cannot be read, the page explains why
  // rather than quietly showing another repository. Without one, the first project whose server
  // can answer is the default, in the workspace's own order; a project known to live on another
  // host is chosen only when nothing else can be.
  const project =
    fixedProject ??
    (search.project
      ? projects.find((candidate) => projectKey(candidate) === search.project)
      : (projects.find((candidate) => availabilityOf(candidate) === "available") ??
        projects.find((candidate) => availabilityOf(candidate) !== "not-github") ??
        projects[0]));
  const availability: ProjectIssuesAvailability | null = project ? availabilityOf(project) : null;
  const readableProject = availability === "available" ? project : undefined;
  const environmentLabel = (project && environmentOf(project)?.label) || "This server";
  // The text being typed belongs to one project and one committed query. When either changes,
  // the draft is dropped, and with it the debounce below, so a search typed for one repository
  // is never committed to another.
  const querySource = `${project ? projectKey(project) : ""}\u0000${search.q}`;
  const [typedQuery, setTypedQuery] = useState({ source: querySource, value: search.q });
  if (typedQuery.source !== querySource) {
    setTypedQuery({ source: querySource, value: search.q });
  }
  const query = typedQuery.source === querySource ? typedQuery.value : search.q;
  const setQuery = (value: string) => setTypedQuery({ source: querySource, value });
  const searchInputRef = useRef<HTMLInputElement>(null);
  // oxlint-disable-next-line t3code/react-effect-budget -- debounces the typed query into the URL; the timer dies with the draft
  useEffect(() => {
    if (query === search.q) return;
    const timeout = window.setTimeout(() => onSearchChange({ q: query, limit: 100 }, true), 350);
    return () => window.clearTimeout(timeout);
  }, [query, search.q, onSearchChange]);

  const listing = useEnvironmentQuery(
    readableProject
      ? issueList({
          environmentId: readableProject.environmentId,
          input: {
            projectId: readableProject.id,
            state: search.state,
            query: `${search.q} sort:${search.issueSort}-desc`,
            limit: search.limit,
          },
        })
      : null,
  );
  const issues = listing.data?.issues ?? [];
  const selectedIssue = issues.find((issue) => issue.number === search.issue);
  const mainRef = useRef<HTMLElement>(null);
  // The issue whose detail was just closed: its row takes focus back once the list is visible
  // again, so keyboard and screen-reader users land where they left the list.
  const returnFocusToIssueRef = useRef<number | null>(null);
  // oxlint-disable-next-line t3code/react-effect-budget -- focus needs the list rows mounted, which happens after the commit that closes the detail
  useEffect(() => {
    const number = returnFocusToIssueRef.current;
    if (search.issue !== undefined || number === null) return;
    returnFocusToIssueRef.current = null;
    const row = mainRef.current?.querySelector<HTMLElement>(`[data-issue-row="${number}"]`);
    (row ?? searchInputRef.current)?.focus();
  }, [search.issue]);
  const selectIssue = (number: number | undefined) =>
    onSearchChange({ issue: number, ...(project ? { project: projectKey(project) } : {}) });

  const closeIssue = () => {
    returnFocusToIssueRef.current = search.issue ?? null;
    selectIssue(undefined);
  };

  const headerContent = (
    <>
      <h1 className="text-sm font-medium">Issues</h1>
      <div className="flex-1" />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Refresh issues"
        disabled={!readableProject || listing.isPending}
        onClick={listing.refresh}
      >
        <RefreshIcon refreshing={listing.isPending} />
      </Button>
    </>
  );

  return (
    <main
      ref={mainRef}
      className="@container/issues flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
      // Escape closes the open issue from anywhere in the view, list or detail. Events that
      // bubble here from a portal (a menu or popover opened inside the view) are left to it.
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || !search.issue) return;
        if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
        event.preventDefault();
        // The phone sheet around the pane would otherwise treat the same key as a request to
        // close itself; the first Escape only steps back to the list.
        event.stopPropagation();
        closeIssue();
      }}
    >
      {embedded ? (
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-4">
          {headerContent}
        </div>
      ) : (
        <WorkspacePageHeader electron={isElectron} className="border-b border-border/60">
          {headerContent}
        </WorkspacePageHeader>
      )}
      <div className="flex min-h-0 flex-1">
        <section
          aria-label="Issue list"
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col",
            search.issue &&
              readableProject &&
              "hidden @min-[900px]/issues:flex @min-[900px]/issues:max-w-[46%] @min-[900px]/issues:border-r @min-[900px]/issues:border-border/60",
          )}
        >
          <div className="space-y-4 border-b border-border/60 px-4 py-5 sm:px-6">
            {fixedProject ? (
              <p className="truncate text-xs text-muted-foreground">{fixedProject.title}</p>
            ) : (
              <label className="block space-y-1.5">
                <span className="text-search-label font-medium text-muted-foreground">Project</span>
                <select
                  aria-label="Issue project"
                  value={project ? projectKey(project) : ""}
                  onChange={(event) =>
                    onSearchChange({
                      project: event.target.value,
                      issue: undefined,
                      q: "",
                      limit: 100,
                    })
                  }
                  className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring sm:h-8"
                >
                  {!project ? <option value="">Select a project</option> : null}
                  {projects.map((candidate) => (
                    <option key={projectKey(candidate)} value={projectKey(candidate)}>
                      {candidate.title} · {candidate.workspaceRoot}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="relative">
              <SearchIcon
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                ref={searchInputRef}
                aria-label="Search issues"
                placeholder="Search issues, or label:bug"
                value={query}
                onChange={(event) => setQuery(event.target.value.slice(0, 450))}
                adornmentInset="both"
                className="h-10 sm:h-9"
              />
              {query ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Clear issue search"
                  className="absolute right-1 top-1/2 -translate-y-1/2"
                  onClick={() => setQuery("")}
                >
                  <XIcon />
                </Button>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex gap-1 rounded-lg bg-muted/40 p-1" aria-label="Issue state">
                {states.map((state) => (
                  <Button
                    key={state.value}
                    variant={search.state === state.value ? "outline" : "ghost-muted"}
                    size="sm"
                    aria-pressed={search.state === state.value}
                    onClick={() => onSearchChange({ state: state.value, limit: 100 })}
                  >
                    {state.label}
                  </Button>
                ))}
              </div>
              <select
                aria-label="Sort issues"
                value={search.issueSort}
                onChange={(event) =>
                  onSearchChange({
                    issueSort: event.target.value === "created" ? "created" : "updated",
                    limit: 100,
                  })
                }
                className="min-h-9 max-w-full rounded-md bg-background px-1 text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
              >
                <option value="updated">Recently updated</option>
                <option value="created">Newest first</option>
              </select>
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-safe-bottom">
            <div
              className="flex items-center justify-between gap-3 px-4 py-3 text-search-label text-muted-foreground sm:px-6"
              aria-live="polite"
            >
              <span className="truncate">{listing.data?.repository ?? "GitHub issues"}</span>
              <span className="shrink-0">
                {listing.isPending
                  ? "Loading…"
                  : `${issues.length}${listing.data?.hasMore ? "+" : ""} issues`}
              </span>
            </div>
            {listing.error ? (
              <div
                role="alert"
                className="mx-4 mb-4 rounded-lg border border-destructive/25 bg-destructive/5 p-4 text-sm"
              >
                <p>{listing.error}</p>
                <Button variant="outline" size="sm" className="mt-3" onClick={listing.refresh}>
                  Try again
                </Button>
              </div>
            ) : null}
            {!project ? (
              !projectsKnown ? (
                <EmptyIssues
                  title="Loading projects"
                  description="Waiting for your servers to connect and list their projects."
                />
              ) : search.project ? (
                <EmptyIssues
                  title="This project is not available"
                  description="The project in this link is not in this workspace. Choose another project above."
                />
              ) : (
                <EmptyIssues
                  title={
                    projects.length === 0
                      ? "Add a project to browse its issues"
                      : "Select a project"
                  }
                  description="Choose a GitHub repository to see its issues here."
                />
              )
            ) : null}
            {project && availability !== null && availability !== "available" ? (
              <EmptyIssues {...unavailableCopy(availability, environmentLabel, project.title)} />
            ) : null}
            {readableProject && issues.length === 0 && !listing.isPending && !listing.error ? (
              <EmptyIssues
                title="No issues under these filters"
                description="Try another state or clear your search."
              />
            ) : null}
            <div
              className="px-2 pb-3 sm:px-3"
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                const buttons = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-issue-row]"),
                );
                const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                if (index < 0) return;
                event.preventDefault();
                buttons[
                  Math.max(
                    0,
                    Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)),
                  )
                ]?.focus();
              }}
            >
              {issues.map((issue) => (
                <button
                  key={issue.number}
                  type="button"
                  data-issue-row={issue.number}
                  aria-pressed={search.issue === issue.number}
                  onClick={() => selectIssue(issue.number)}
                  className={cn(
                    "group flex w-full items-start gap-3 rounded-lg px-3 py-4 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    search.issue === issue.number && "bg-accent/60",
                  )}
                >
                  <IssueStatus state={issue.state} className="mt-0.5" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <p className="text-sm font-medium leading-relaxed text-foreground/90">
                      {issue.title}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-search-label text-muted-foreground">
                      <span className="font-mono">#{issue.number}</span>
                      <span>by {authorLogin(issue.author)}</span>
                      <span>· {formatRelativeTimeLabel(issue.updatedAt)}</span>
                    </div>
                    {issue.labels.length ? <IssueLabels labels={issue.labels} /> : null}
                  </div>
                  <ArrowUpRightIcon
                    aria-hidden
                    className="mt-1 hidden size-3.5 shrink-0 text-muted-foreground group-hover:block"
                  />
                </button>
              ))}
            </div>
            {listing.data?.hasMore ? (
              <div className="px-6 pb-5 text-center">
                {search.limit < 500 ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={listing.isPending}
                    onClick={() => onSearchChange({ limit: Math.min(search.limit + 100, 500) })}
                  >
                    Load more issues
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Showing the first 500 matches. Narrow your search to find more issues.
                  </p>
                )}
              </div>
            ) : null}
          </div>
        </section>
        {search.issue && readableProject ? (
          <IssueDetailPane
            key={`${projectKey(readableProject)}:${search.issue}`}
            project={readableProject}
            number={search.issue}
            summary={selectedIssue}
            repositoryUrl={listing.data?.repositoryUrl ?? null}
            onClose={closeIssue}
            onLabel={(label) =>
              onSearchChange({ q: `label:${JSON.stringify(label)}`, issue: undefined, limit: 100 })
            }
          />
        ) : null}
      </div>
    </main>
  );
}

function EmptyIssues({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <CircleDotIcon className="size-8 text-muted-foreground/40" aria-hidden />
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">{description}</p>
    </div>
  );
}

function IssueDetailPane({
  project,
  number,
  summary,
  repositoryUrl,
  onClose,
  onLabel,
}: {
  project: EnvironmentProject;
  number: number;
  summary: IssueSummary | undefined;
  repositoryUrl: string | null;
  onClose: () => void;
  onLabel: (label: string) => void;
}) {
  const detail = useEnvironmentQuery(
    issueDetail({ environmentId: project.environmentId, input: { projectId: project.id, number } }),
  );
  const issue = detail.data ?? summary;
  const markdownContext = useMemo(() => {
    const findAutolinks = sourceControlClients.get("github").referenceAutolinks;
    return {
      autolinks:
        repositoryUrl !== null && findAutolinks !== undefined
          ? (text: string) => findAutolinks(text, repositoryUrl)
          : null,
      threadRef: null,
    };
  }, [repositoryUrl]);
  // A detail opens because the reader chose an issue, so it takes focus: on a narrow pane the
  // row that was clicked is hidden, and keys must still reach this view. `key` remounts the
  // section for each issue, so choosing another one moves focus again.
  const focusOnMount = useCallback((node: HTMLElement | null) => {
    node?.focus({ preventScroll: true });
  }, []);
  return (
    <section
      ref={focusOnMount}
      tabIndex={-1}
      aria-label={`Issue #${number} details`}
      className="flex min-h-0 min-w-0 flex-1 flex-col outline-none"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2 sm:px-5">
        <Button variant="ghost" size="sm" onClick={onClose}>
          <ArrowLeftIcon /> <span className="@min-[900px]/issues:hidden">Issues</span>
          <span className="hidden @min-[900px]/issues:inline">Close</span>
        </Button>
        <span className="font-mono text-xs text-muted-foreground">#{number}</span>
        <div className="flex-1" />
        {issue ? (
          <Button
            variant="ghost"
            size="sm"
            render={<a href={issue.url} target="_blank" rel="noopener noreferrer" />}
          >
            GitHub <ArrowUpRightIcon />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh issue details"
          disabled={detail.isPending}
          onClick={detail.refresh}
        >
          <RefreshIcon refreshing={detail.isPending} />
        </Button>
      </div>
      <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto px-5 pt-6 pb-safe-content sm:px-8">
        <div className="mx-auto max-w-3xl space-y-6">
          {issue ? (
            <>
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-xs">
                  <IssueStatus state={issue.state} />
                  <span>{issue.state === "OPEN" ? "Open" : "Closed"}</span>
                  <span className="text-muted-foreground">· #{number}</span>
                </div>
                <h2 className="text-xl font-semibold leading-snug tracking-tight sm:text-2xl">
                  {issue.title}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {authorLogin(issue.author)} opened this issue ·{" "}
                  {formatRelativeTimeLabel(issue.createdAt)}
                </p>
                <IssueLabels labels={issue.labels} onLabel={onLabel} />
                {issue.assignees.length ? (
                  <p className="text-xs text-muted-foreground">
                    Assigned to {issue.assignees.map((assignee) => assignee.login).join(", ")}
                  </p>
                ) : null}
              </div>
            </>
          ) : null}
          {detail.error ? (
            <div role="alert" className="rounded-lg border border-destructive/25 p-4 text-sm">
              {detail.error}
              <Button variant="outline" size="sm" className="mt-3 block" onClick={detail.refresh}>
                Try again
              </Button>
            </div>
          ) : null}
          {detail.isPending && !detail.data ? (
            <p className="text-sm text-muted-foreground" role="status">
              Loading description and comments…
            </p>
          ) : null}
          {detail.data ? (
            <PullRequestMarkdownContext.Provider value={markdownContext}>
              <div className="border-t border-border/60 pt-6">
                {detail.data.body ? (
                  <PullRequestMarkdown
                    text={detail.data.body}
                    cwd={project.workspaceRoot}
                    environmentId={project.environmentId}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">No description provided.</p>
                )}
              </div>
              <div className="space-y-5 border-t border-border/60 pt-6">
                <h3 className="text-xs font-medium text-muted-foreground">
                  Discussion · {detail.data.comments.length}
                </h3>
                {detail.data.comments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No comments yet.</p>
                ) : (
                  detail.data.comments.map((comment) => (
                    <article
                      key={comment.id}
                      className="space-y-3 rounded-lg border border-border/60 p-4"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-medium">{authorLogin(comment.author)}</span>
                        <a
                          className="text-muted-foreground hover:underline"
                          href={comment.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {formatRelativeTimeLabel(comment.createdAt)}
                        </a>
                      </div>
                      <PullRequestMarkdown
                        text={comment.body}
                        cwd={project.workspaceRoot}
                        environmentId={project.environmentId}
                      />
                    </article>
                  ))
                )}
              </div>
            </PullRequestMarkdownContext.Provider>
          ) : null}
        </div>
      </div>
    </section>
  );
}
