import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { IssueState } from "@t3tools/contracts";

export interface IssueSearch {
  project?: string | undefined;
  issue?: number | undefined;
  state: IssueState;
  q: string;
  issueSort: "updated" | "created";
  limit: number;
}

export function parseIssueSearch(raw: Record<string, unknown>): IssueSearch {
  const issue = Number(raw.issue);
  const limit = Number(raw.limit);
  return {
    project: typeof raw.project === "string" ? raw.project : undefined,
    issue: Number.isSafeInteger(issue) && issue > 0 ? issue : undefined,
    state: raw.state === "closed" || raw.state === "all" ? raw.state : "open",
    q: typeof raw.q === "string" ? raw.q.slice(0, 450) : "",
    issueSort: raw.issueSort === "created" ? "created" : "updated",
    limit: Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100,
  };
}

/**
 * Whether an environment can answer issue reads right now. The thread pane, the standalone page
 * and every entry point read this one answer, and only `available` may create an issue query: an
 * older server would reject the unknown method, and an unreported capability is not yet a yes.
 */
export type IssuesAvailability = "available" | "unsupported" | "loading" | "disconnected";

export function issuesAvailability(
  environment: Pick<EnvironmentPresentation, "connection" | "serverConfig"> | null,
): IssuesAvailability {
  if (environment === null) return "disconnected";
  const { connection, serverConfig } = environment;
  if (serverConfig === null) {
    return connection.phase === "connecting" ||
      connection.phase === "reconnecting" ||
      connection.phase === "connected"
      ? "loading"
      : "disconnected";
  }
  if (serverConfig.environment.capabilities.issues !== true) return "unsupported";
  return connection.phase === "connected" ? "available" : "disconnected";
}

/**
 * The availability decision for one project. A project whose repository is known to live on
 * another host can never be read; one whose identity is not known yet is left to the server,
 * which resolves the repository from the project's workspace and explains a non-GitHub one.
 */
export type ProjectIssuesAvailability = IssuesAvailability | "not-github";

export function projectIssuesAvailability(
  project: Pick<EnvironmentProject, "repositoryIdentity">,
  environment: Pick<EnvironmentPresentation, "connection" | "serverConfig"> | null,
): ProjectIssuesAvailability {
  const provider = project.repositoryIdentity?.provider;
  if (provider !== undefined && provider !== "github") return "not-github";
  return issuesAvailability(environment);
}

/** Whether a link to the standalone Issues page can lead anywhere. */
export function someEnvironmentHasIssues(
  environments: ReadonlyArray<Pick<EnvironmentPresentation, "connection" | "serverConfig">>,
): boolean {
  return environments.some((environment) => issuesAvailability(environment) === "available");
}
