import {
  IssueDetail,
  IssueReadError,
  IssueSummary,
  issueRepositoryUrl,
  type IssueListInput,
  type IssueDetailInput,
  type IssueReference,
  type IssueReferenceInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as GitHubIssueCli from "./GitHubIssueCli.ts";

const summaryFields = "number,title,url,state,author,assignees,labels,createdAt,updatedAt";
const decodeRepository = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ nameWithOwner: Schema.String, url: Schema.String })),
);
const decodeList = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(IssueSummary)));
const decodeDetail = Schema.decodeUnknownEffect(Schema.fromJsonString(IssueDetail));
/** The fields of GitHub's REST issue record that tell an issue from a pull request. */
const decodeReferenceRecord = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      number: Schema.Int,
      html_url: Schema.String,
      pull_request: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
    }),
  ),
);
const isIssueReadError = Schema.is(IssueReadError);

const resolveProjectRepository = Effect.fn("issues.resolveProjectRepository")(function* (
  projectId: IssueListInput["projectId"],
) {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const project = yield* projects
    .getShell(projectId)
    .pipe(Effect.mapError(() => new IssueReadError({ message: "Could not read this project." })));
  if (Option.isNone(project))
    return yield* new IssueReadError({ message: "This project is no longer available." });
  const cwd = project.value.workspaceRoot;
  // The V2 project store keeps shells without enrichment, so the identity
  // comes from the resolver the shell stream enriches them with.
  const identity = yield* (yield* RepositoryIdentityResolver.RepositoryIdentityResolver).resolve(
    cwd,
  );
  if (identity?.provider && identity.provider !== "github") {
    return yield* new IssueReadError({
      message: "Issues are available for GitHub repositories only.",
    });
  }
  const github = yield* GitHubIssueCli.GitHubIssueCli;
  // Without a recorded identity, `gh` reads the checkout's default remote. A recorded one decides
  // the repository, and one that is incomplete or names two repositories is refused rather than
  // left to that default, which in a fork with an `upstream` remote is the fork.
  const repositoryUrl = identity ? issueRepositoryUrl(identity) : null;
  if (identity && repositoryUrl === null) {
    return yield* new IssueReadError({
      message: "This project's recorded repository is incomplete or inconsistent.",
    });
  }
  const expected =
    repositoryUrl === null
      ? null
      : new URL(repositoryUrl).pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
  const output = yield* github.execute({
    cwd,
    args: [
      "repo",
      "view",
      ...(repositoryUrl ? [repositoryUrl] : []),
      "--json",
      "nameWithOwner,url",
    ],
  });
  const repository = yield* decodeRepository(output.stdout).pipe(
    Effect.mapError(
      () => new IssueReadError({ message: "GitHub returned an invalid repository." }),
    ),
  );
  if (expected !== null && repository.nameWithOwner.toLowerCase() !== expected.toLowerCase()) {
    return yield* new IssueReadError({
      message: `GitHub answered with ${repository.nameWithOwner} instead of this project's ${expected}.`,
    });
  }
  return { github, cwd, repository };
});

/** Truncated output is never valid JSON; report the size limit instead of a decode failure. */
const failWhenTruncated = Effect.fn("issues.failWhenTruncated")(function* (
  output: { readonly stdoutTruncated: boolean },
  message: string,
) {
  if (output.stdoutTruncated) return yield* new IssueReadError({ message });
});

/**
 * `gh` wraps the search in `( … )` before adding its own `repo:` qualifier, so an unbalanced
 * parenthesis or an unclosed quote can move that qualifier out of the group and widen the
 * search past the project's repository. Text inside quotes is literal and is not counted.
 */
function isBalancedIssueSearch(query: string): boolean {
  let depth = 0;
  let quoted = false;
  for (const character of query) {
    if (character === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (character === "(") depth += 1;
    else if (character === ")" && --depth < 0) return false;
  }
  return depth === 0 && !quoted;
}

/** GitHub writes every issue URL as `<repository url>/issues/<number>`. */
function isIssueOfRepository(
  issue: { readonly number: number; readonly url: string },
  repositoryUrl: string,
): boolean {
  const expected = `${repositoryUrl.replace(/\/+$/u, "")}/issues/${issue.number}`;
  return issue.url.toLowerCase() === expected.toLowerCase();
}

function readError(error: { readonly message: string }) {
  return isIssueReadError(error) ? error : new IssueReadError({ message: error.message });
}

/** Fetch summaries only. Bodies and comments load when the reader opens an issue. */
export const listIssues = Effect.fn("issues.list")(function* (input: IssueListInput) {
  const query = input.query.trim();
  if (!isBalancedIssueSearch(query)) {
    return yield* new IssueReadError({
      message: "Close every parenthesis and quotation mark in the search.",
    });
  }
  const { github, cwd, repository } = yield* resolveProjectRepository(input.projectId);
  const args = [
    "issue",
    "list",
    "--repo",
    repository.url,
    "--state",
    input.state,
    "--limit",
    String(input.limit + 1),
    "--json",
    summaryFields,
  ];
  if (query) args.push("--search", query);
  const output = yield* github.execute({ cwd, args, maxOutputBytes: 2_000_000 });
  yield* failWhenTruncated(
    output,
    "GitHub returned more issues than this view can read. Narrow the search or load fewer issues.",
  );
  const issues = yield* decodeList(output.stdout).pipe(
    Effect.mapError(
      () => new IssueReadError({ message: "GitHub returned an invalid issue list." }),
    ),
  );
  // Reject the whole page rather than filter it: a filtered page would misreport hasMore.
  if (!issues.every((issue) => isIssueOfRepository(issue, repository.url))) {
    return yield* new IssueReadError({
      message: "GitHub returned issues from another repository. Check the search and try again.",
    });
  }
  return {
    repository: repository.nameWithOwner,
    repositoryUrl: repository.url,
    issues: issues.slice(0, input.limit),
    hasMore: issues.length > input.limit,
  };
}, Effect.mapError(readError));

export const readIssueDetail = Effect.fn("issues.detail")(function* (input: IssueDetailInput) {
  const { github, cwd, repository } = yield* resolveProjectRepository(input.projectId);
  const output = yield* github.execute({
    cwd,
    args: [
      "issue",
      "view",
      String(input.number),
      "--repo",
      repository.url,
      "--json",
      `${summaryFields},body,comments`,
    ],
    maxOutputBytes: 4_000_000,
  });
  yield* failWhenTruncated(output, "This issue is too large to read here. Open it on GitHub.");
  const detail = yield* decodeDetail(output.stdout).pipe(
    Effect.mapError(
      () => new IssueReadError({ message: "GitHub returned an invalid issue detail." }),
    ),
  );
  if (detail.number !== input.number || !isIssueOfRepository(detail, repository.url)) {
    return yield* new IssueReadError({
      message: `GitHub did not return issue #${input.number} of ${repository.nameWithOwner}.`,
    });
  }
  return detail;
}, Effect.mapError(readError));

/**
 * Whether an issue number of the project's repository names an issue or a pull request. GitHub's
 * REST issue endpoint answers for both and marks a pull request with `pull_request`, so the
 * answer is GitHub's, never a guess from the URL a reader clicked.
 */
export const resolveIssueReference = Effect.fn("issues.resolveReference")(function* (
  input: IssueReferenceInput,
) {
  const { github, cwd, repository } = yield* resolveProjectRepository(input.projectId);
  const repositoryUrl = new URL(repository.url);
  const output = yield* github.execute({
    cwd,
    args: [
      "api",
      "--hostname",
      repositoryUrl.host,
      "--jq",
      "{number: .number, html_url: .html_url, pull_request: .pull_request}",
      `repos/${repository.nameWithOwner}/issues/${input.number}`,
    ],
    maxOutputBytes: 100_000,
  });
  yield* failWhenTruncated(output, "GitHub returned an unexpectedly large reference.");
  const record = yield* decodeReferenceRecord(output.stdout).pipe(
    Effect.mapError(
      () => new IssueReadError({ message: "GitHub returned an invalid issue reference." }),
    ),
  );
  const kind: IssueReference["kind"] =
    record.pull_request === undefined || record.pull_request === null ? "issue" : "pull-request";
  const expected = `${repository.url.replace(/\/+$/u, "")}/${kind === "issue" ? "issues" : "pull"}/${input.number}`;
  if (record.number !== input.number || record.html_url.toLowerCase() !== expected.toLowerCase()) {
    return yield* new IssueReadError({
      message: `GitHub did not return #${input.number} of ${repository.nameWithOwner}.`,
    });
  }
  return {
    kind,
    number: input.number,
    url: record.html_url,
    repository: repository.nameWithOwner,
  } satisfies IssueReference;
}, Effect.mapError(readError));
