import * as Schema from "effect/Schema";

import { PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import type { RepositoryIdentity } from "./environment.ts";

export const IssueState = Schema.Literals(["open", "closed", "all"]);
export type IssueState = typeof IssueState.Type;

export const IssueSummary = Schema.Struct({
  number: PositiveInt,
  title: Schema.String,
  url: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED"]),
  author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  assignees: Schema.Array(Schema.Struct({ login: Schema.String })),
  labels: Schema.Array(Schema.Struct({ name: Schema.String, color: Schema.String })),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type IssueSummary = typeof IssueSummary.Type;

export const IssueDetail = Schema.Struct({
  ...IssueSummary.fields,
  body: Schema.String,
  comments: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
      body: Schema.String,
      createdAt: Schema.String,
      url: Schema.String,
    }),
  ),
});
export type IssueDetail = typeof IssueDetail.Type;

export const IssueListInput = Schema.Struct({
  projectId: ProjectId,
  state: IssueState,
  query: Schema.String.check(Schema.isMaxLength(500)),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
});
export type IssueListInput = typeof IssueListInput.Type;

export const IssueListResult = Schema.Struct({
  repository: Schema.String,
  repositoryUrl: Schema.String,
  issues: Schema.Array(IssueSummary),
  hasMore: Schema.Boolean,
});
export type IssueListResult = typeof IssueListResult.Type;

export const IssueDetailInput = Schema.Struct({ projectId: ProjectId, number: PositiveInt });
export type IssueDetailInput = typeof IssueDetailInput.Type;

export const IssueReferenceInput = IssueDetailInput;
export type IssueReferenceInput = typeof IssueReferenceInput.Type;

/**
 * What an issue number of a project's repository names. GitHub numbers issues and pull requests
 * in one sequence and serves both under `/issues/`, so only GitHub can say which one it is.
 */
export const IssueReference = Schema.Struct({
  kind: Schema.Literals(["issue", "pull-request"]),
  number: PositiveInt,
  url: Schema.String,
  repository: Schema.String,
});
export type IssueReference = typeof IssueReference.Type;

export class IssueReadError extends Schema.TaggedError<IssueReadError>()("IssueReadError", {
  message: TrimmedNonEmptyString,
}) {}

/** `owner/name`, the only repository path GitHub has. */
const GITHUB_REPOSITORY_PATH = /^[^/\s]+\/[^/\s]+$/u;

/**
 * The GitHub web URL of the repository a project's identity names. Issue reads use it, not the
 * checkout's default remote, which in a fork with an `upstream` remote is the fork. Null for
 * another provider, for too little to address a repository, and when the naming fields (canonical
 * key, web URL, display name, owner/name) disagree: a doubtful identity is refused, not guessed.
 */
export function issueRepositoryUrl(
  identity:
    | Pick<
        RepositoryIdentity,
        "provider" | "webUrl" | "displayName" | "owner" | "name" | "canonicalKey" | "locator"
      >
    | null
    | undefined,
): string | null {
  if (!identity || (identity.provider !== undefined && identity.provider !== "github")) return null;
  const host = identity.canonicalKey?.split("/")[0]?.trim().toLowerCase() || "github";
  const paths: string[] = [];
  const canonicalPath = identity.canonicalKey.split("/").slice(1).join("/");
  if (canonicalPath) paths.push(canonicalPath);
  if (identity.webUrl) {
    let webUrl: URL;
    try {
      webUrl = new URL(identity.webUrl);
    } catch {
      return null;
    }
    if (
      (webUrl.protocol !== "https:" && webUrl.protocol !== "http:") ||
      webUrl.hostname.toLowerCase() !== host
    )
      return null;
    paths.push(webUrl.pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, ""));
  }
  if (identity.displayName) paths.push(identity.displayName);
  if (identity.owner || identity.name) paths.push(`${identity.owner ?? ""}/${identity.name ?? ""}`);
  const repository = paths[0];
  if (
    repository === undefined ||
    !GITHUB_REPOSITORY_PATH.test(repository) ||
    paths.some((path) => path.toLowerCase() !== repository.toLowerCase())
  )
    return null;
  return identity.webUrl ?? `https://${host}/${repository}`;
}
