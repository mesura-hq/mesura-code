import { assert, it } from "@effect/vitest";
import { ProjectId, type OrchestrationProjectShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import { listIssues, readIssueDetail, resolveIssueReference } from "./readIssues.ts";

const projectId = ProjectId.make("issue-project");
const project: OrchestrationProjectShell = {
  id: projectId,
  title: "Example",
  workspaceRoot: "/repo",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  repositoryIdentity: {
    canonicalKey: "github.com/acme/app",
    provider: "github",
    webUrl: "https://github.com/acme/app",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:acme/app.git",
    },
  },
};
const summary = {
  number: 1,
  title: "A real issue",
  url: "https://github.com/acme/app/issues/1",
  state: "OPEN",
  author: null,
  labels: [{ name: "bug", color: "ff0000" }],
  assignees: [],
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
};

/** A summary GitHub would return for issue `number` of acme/app. */
function summaryNumbered(number: number) {
  return { ...summary, number, url: `https://github.com/acme/app/issues/${number}` };
}

function mockReads(input: {
  project?: Option.Option<OrchestrationProjectShell>;
  execute: GitHubCli.GitHubCli["Service"]["execute"];
}) {
  return Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getProjectShellById: () => Effect.succeed(input.project ?? Option.some(project)),
    }),
    Layer.mock(GitHubCli.GitHubCli)({ execute: input.execute }),
  );
}

function output(value: unknown) {
  return Effect.succeed({
    stdout: JSON.stringify(value),
    stderr: "",
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdoutTruncated: false,
    stderrTruncated: false,
  });
}

it.effect(
  "reads the project repository and detects additional results without loading bodies",
  () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const result = yield* listIssues({
        projectId,
        state: "open",
        query: "label:bug",
        limit: 1,
      }).pipe(
        Effect.provide(
          mockReads({
            execute: ({ args }) => {
              calls.push(args);
              return args[0] === "repo"
                ? output({ nameWithOwner: "acme/app", url: "https://github.com/acme/app" })
                : output([summary, summaryNumbered(2)]);
            },
          }),
        ),
      );
      assert.equal(result.hasMore, true);
      assert.equal(result.issues.length, 1);
      assert.equal(result.issues[0]?.author, null);
      assert.deepStrictEqual(calls[0], [
        "repo",
        "view",
        "https://github.com/acme/app",
        "--json",
        "nameWithOwner,url",
      ]);
      assert.deepStrictEqual(calls[1], [
        "issue",
        "list",
        "--repo",
        "https://github.com/acme/app",
        "--state",
        "open",
        "--limit",
        "2",
        "--json",
        "number,title,url,state,author,assignees,labels,createdAt,updatedAt",
        "--search",
        "label:bug",
      ]);
    }),
);

it.effect("loads description and comments only for the selected issue", () =>
  Effect.gen(function* () {
    const result = yield* readIssueDetail({ projectId, number: 1 }).pipe(
      Effect.provide(
        mockReads({
          execute: ({ args }) => {
            return args[0] === "repo"
              ? output({ nameWithOwner: "acme/app", url: "https://github.com/acme/app" })
              : output({
                  ...summary,
                  body: "Investigate the bug.",
                  comments: [
                    {
                      id: "comment-1",
                      author: null,
                      body: "More context",
                      createdAt: summary.createdAt,
                      url: `${summary.url}#issuecomment-1`,
                    },
                  ],
                });
          },
        }),
      ),
    );
    assert.equal(result.body, "Investigate the bug.");
    assert.equal(result.comments[0]?.body, "More context");
  }),
);

it.effect("rejects missing projects before calling GitHub", () =>
  Effect.gen(function* () {
    const error = yield* listIssues({ projectId, state: "all", query: "", limit: 100 }).pipe(
      Effect.provide(
        mockReads({
          project: Option.none(),
          execute: () => {
            throw new Error("Must not call GitHub");
          },
        }),
      ),
      Effect.flip,
    );
    assert.equal(error.message, "This project is no longer available.");
  }),
);

it.effect("rejects other source-control providers before calling GitHub", () =>
  Effect.gen(function* () {
    const error = yield* listIssues({ projectId, state: "all", query: "", limit: 100 }).pipe(
      Effect.provide(
        mockReads({
          project: Option.some({
            ...project,
            repositoryIdentity: { ...project.repositoryIdentity!, provider: "gitlab" },
          }),
          execute: () => {
            throw new Error("Must not call GitHub");
          },
        }),
      ),
      Effect.flip,
    );
    assert.equal(error.message, "Issues are available for GitHub repositories only.");
  }),
);

it.effect("returns a readable error for malformed GitHub responses", () =>
  Effect.gen(function* () {
    const error = yield* listIssues({ projectId, state: "open", query: "", limit: 100 }).pipe(
      Effect.provide(
        mockReads({
          execute: ({ args }) =>
            args[0] === "repo"
              ? output({ nameWithOwner: "acme/app", url: "https://github.com/acme/app" })
              : output([{ number: "invalid" }]),
        }),
      ),
      Effect.flip,
    );
    assert.equal(error.message, "GitHub returned an invalid issue list.");
  }),
);

it.effect("preserves GitHub authentication errors", () =>
  Effect.gen(function* () {
    const error = yield* listIssues({ projectId, state: "open", query: "", limit: 100 }).pipe(
      Effect.provide(
        mockReads({
          execute: () =>
            Effect.fail(
              new GitHubCli.GitHubCliAuthenticationError({
                cwd: "/repo",
                command: "gh",
                cause: new Error("auth"),
              }),
            ),
        }),
      ),
      Effect.flip,
    );
    assert.match(error.message, /gh auth login/);
  }),
);

type ExecuteInput = Parameters<GitHubCli.GitHubCli["Service"]["execute"]>[0];

const repositoryOutput = () =>
  output({ nameWithOwner: "acme/app", url: "https://github.com/acme/app" });

const forbidGitHub: GitHubCli.GitHubCli["Service"]["execute"] = () => {
  throw new Error("Must not call GitHub");
};

const gitlabProject = Option.some<OrchestrationProjectShell>({
  ...project,
  repositoryIdentity: { ...project.repositoryIdentity!, provider: "gitlab" },
});

// The shape `gh` prints for a deleted account: its Go structs keep the object and empty the login.
const ghDeletedIssueAuthor = { id: "", is_bot: false, login: "", name: "" };

const detailResponse = {
  ...summary,
  author: ghDeletedIssueAuthor,
  body: "Investigate the bug.",
  comments: [
    {
      id: "IC_deleted",
      author: { login: "" },
      authorAssociation: "NONE",
      body: "Posted by a deleted account",
      createdAt: summary.createdAt,
      url: `${summary.url}#issuecomment-1`,
    },
    {
      id: "IC_null",
      author: null,
      authorAssociation: "NONE",
      body: "Posted without an author record",
      createdAt: summary.createdAt,
      url: `${summary.url}#issuecomment-2`,
    },
  ],
};

it.effect("reads issue detail from the requested project's trusted repository", () =>
  Effect.gen(function* () {
    const requestedProjects: Array<string> = [];
    const calls: Array<ExecuteInput> = [];
    yield* readIssueDetail({ projectId, number: 42 }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionSnapshotQuery)({
            getProjectShellById: (id) =>
              Effect.sync(() => {
                requestedProjects.push(id);
                return Option.some(project);
              }),
          }),
          Layer.mock(GitHubCli.GitHubCli)({
            execute: (input) => {
              calls.push(input);
              return input.args[0] === "repo"
                ? repositoryOutput()
                : output({ ...detailResponse, ...summaryNumbered(42) });
            },
          }),
        ),
      ),
    );
    assert.deepStrictEqual(requestedProjects, [projectId]);
    assert.deepStrictEqual(
      calls.map((call) => call.cwd),
      ["/repo", "/repo"],
    );
    assert.deepStrictEqual(calls[0]?.args, [
      "repo",
      "view",
      "https://github.com/acme/app",
      "--json",
      "nameWithOwner,url",
    ]);
    assert.deepStrictEqual(calls[1]?.args, [
      "issue",
      "view",
      "42",
      "--repo",
      "https://github.com/acme/app",
      "--json",
      "number,title,url,state,author,assignees,labels,createdAt,updatedAt,body,comments",
    ]);
    assert.isTrue(Number.isFinite(calls[1]?.maxOutputBytes));
  }),
);

it.effect("rejects missing projects before reading issue detail from GitHub", () =>
  Effect.gen(function* () {
    const error = yield* readIssueDetail({ projectId, number: 1 }).pipe(
      Effect.provide(mockReads({ project: Option.none(), execute: forbidGitHub })),
      Effect.flip,
    );
    assert.equal(error._tag, "IssueReadError");
    assert.equal(error.message, "This project is no longer available.");
  }),
);

it.effect("rejects other source-control providers before reading issue detail from GitHub", () =>
  Effect.gen(function* () {
    const error = yield* readIssueDetail({ projectId, number: 1 }).pipe(
      Effect.provide(mockReads({ project: gitlabProject, execute: forbidGitHub })),
      Effect.flip,
    );
    assert.equal(error._tag, "IssueReadError");
    assert.match(error.message, /GitHub repositories/);
  }),
);

it.effect("reports no further issues when GitHub returns no more than the requested page", () =>
  Effect.gen(function* () {
    const result = yield* listIssues({ projectId, state: "all", query: "", limit: 2 }).pipe(
      Effect.provide(
        mockReads({
          execute: ({ args }) =>
            args[0] === "repo" ? repositoryOutput() : output([summary, summaryNumbered(2)]),
        }),
      ),
    );
    assert.equal(result.hasMore, false);
    assert.deepStrictEqual(
      result.issues.map((issue) => issue.number),
      [1, 2],
    );
    assert.equal(result.repository, "acme/app");
    assert.equal(result.repositoryUrl, "https://github.com/acme/app");
  }),
);

it.effect("lists issue summaries with bounded output and without descriptions or comments", () =>
  Effect.gen(function* () {
    const calls: Array<ExecuteInput> = [];
    const result = yield* listIssues({ projectId, state: "closed", query: "   ", limit: 5 }).pipe(
      Effect.provide(
        mockReads({
          execute: (input) => {
            calls.push(input);
            return input.args[0] === "repo"
              ? repositoryOutput()
              : output([{ ...summary, body: "Not requested", comments: [] }]);
          },
        }),
      ),
    );
    const listCall = calls.find((call) => call.args[0] === "issue");
    assert.isDefined(listCall);
    const fields = listCall!.args[listCall!.args.indexOf("--json") + 1]?.split(",") ?? [];
    assert.notInclude(fields, "body");
    assert.notInclude(fields, "comments");
    assert.notInclude(listCall!.args, "--search");
    assert.isTrue(Number.isFinite(listCall!.maxOutputBytes));
    assert.notProperty(result.issues[0], "body");
    assert.notProperty(result.issues[0], "comments");
  }),
);

it.effect("lists issues whose authors GitHub reports as deleted accounts", () =>
  Effect.gen(function* () {
    const result = yield* listIssues({ projectId, state: "open", query: "", limit: 10 }).pipe(
      Effect.provide(
        mockReads({
          execute: ({ args }) =>
            args[0] === "repo"
              ? repositoryOutput()
              : output([
                  { ...summary, author: ghDeletedIssueAuthor },
                  {
                    ...summaryNumbered(2),
                    labels: [{ id: "LA_1", name: "bug", color: "ff0000", description: "" }],
                  },
                ]),
        }),
      ),
    );
    assert.deepStrictEqual(result.issues[0]?.author, { login: "" });
    assert.deepStrictEqual(result.issues[1]?.labels, [{ name: "bug", color: "ff0000" }]);
  }),
);

it.effect("returns issue detail comments written by deleted accounts", () =>
  Effect.gen(function* () {
    const result = yield* readIssueDetail({ projectId, number: 1 }).pipe(
      Effect.provide(
        mockReads({
          execute: ({ args }) => (args[0] === "repo" ? repositoryOutput() : output(detailResponse)),
        }),
      ),
    );
    assert.equal(result.body, "Investigate the bug.");
    assert.deepStrictEqual(result.author, { login: "" });
    assert.deepStrictEqual(
      result.comments.map((comment) => [comment.id, comment.author, comment.body]),
      [
        ["IC_deleted", { login: "" }, "Posted by a deleted account"],
        ["IC_null", null, "Posted without an author record"],
      ],
    );
  }),
);

it.effect("returns a readable error for a malformed GitHub issue detail", () =>
  Effect.gen(function* () {
    const error = yield* readIssueDetail({ projectId, number: 1 }).pipe(
      Effect.provide(
        mockReads({
          execute: ({ args }) =>
            args[0] === "repo" ? repositoryOutput() : output({ number: 1, body: 3 }),
        }),
      ),
      Effect.flip,
    );
    assert.equal(error._tag, "IssueReadError");
    assert.equal(error.message, "GitHub returned an invalid issue detail.");
  }),
);

it.effect("returns a readable error for a malformed GitHub repository lookup", () =>
  Effect.gen(function* () {
    const error = yield* listIssues({ projectId, state: "open", query: "", limit: 10 }).pipe(
      Effect.provide(mockReads({ execute: () => output({ nameWithOwner: 1 }) })),
      Effect.flip,
    );
    assert.equal(error._tag, "IssueReadError");
    assert.equal(error.message, "GitHub returned an invalid repository.");
  }),
);

const gitHubCliFailures = [
  {
    name: "an unavailable GitHub CLI",
    error: new GitHubCli.GitHubCliUnavailableError({ cwd: "/repo", command: "gh", cause: null }),
    remedy: /not available on PATH/,
  },
  {
    name: "a GitHub rate limit",
    error: new GitHubCli.GitHubCliRateLimitError({ cwd: "/repo", command: "gh", cause: null }),
    remedy: /rate limit/,
  },
  {
    name: "missing GitHub authentication",
    error: new GitHubCli.GitHubCliAuthenticationError({ cwd: "/repo", command: "gh", cause: null }),
    remedy: /gh auth login/,
  },
  {
    name: "a failed GitHub command",
    error: new GitHubCli.GitHubCliCommandError({ cwd: "/repo", command: "gh", cause: null }),
    remedy: /GitHub CLI command failed/,
  },
] as const;

for (const failure of gitHubCliFailures) {
  it.effect(`returns a recoverable issue read error for ${failure.name}`, () =>
    Effect.gen(function* () {
      let executions = 0;
      const failing = mockReads({
        execute: ({ args }) => {
          executions += 1;
          return args[0] === "repo" ? repositoryOutput() : Effect.fail(failure.error);
        },
      });
      const listError = yield* listIssues({
        projectId,
        state: "open",
        query: "",
        limit: 10,
      }).pipe(Effect.provide(failing), Effect.flip);
      const detailError = yield* readIssueDetail({ projectId, number: 1 }).pipe(
        Effect.provide(failing),
        Effect.flip,
      );
      for (const error of [listError, detailError]) {
        assert.equal(error._tag, "IssueReadError");
        assert.match(error.message, failure.remedy);
      }

      // Recoverable: the next read after the failure cause clears runs again and succeeds.
      const retried = yield* listIssues({ projectId, state: "open", query: "", limit: 10 }).pipe(
        Effect.provide(
          mockReads({
            execute: ({ args }) => (args[0] === "repo" ? repositoryOutput() : output([summary])),
          }),
        ),
      );
      assert.equal(retried.issues.length, 1);
      assert.equal(executions, 4);
    }),
  );
}

function truncatedOutput(stdout: string) {
  return Effect.succeed({
    stdout,
    stderr: "",
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdoutTruncated: true,
    stderrTruncated: false,
  });
}

it.effect("reports an issue list that exceeds the output bound instead of a decode failure", () =>
  Effect.gen(function* () {
    const error = yield* listIssues({ projectId, state: "all", query: "", limit: 500 }).pipe(
      Effect.provide(
        mockReads({
          execute: ({ args }) =>
            args[0] === "repo" ? repositoryOutput() : truncatedOutput('[{"number":1,"tit'),
        }),
      ),
      Effect.flip,
    );
    assert.equal(error._tag, "IssueReadError");
    assert.match(error.message, /Narrow the search or load fewer issues/);
  }),
);

it.effect("reports an issue detail that exceeds the output bound instead of a decode failure", () =>
  Effect.gen(function* () {
    const error = yield* readIssueDetail({ projectId, number: 1 }).pipe(
      Effect.provide(
        mockReads({
          execute: ({ args }) =>
            args[0] === "repo" ? repositoryOutput() : truncatedOutput('{"number":1,"bo'),
        }),
      ),
      Effect.flip,
    );
    assert.equal(error._tag, "IssueReadError");
    assert.match(error.message, /Open it on GitHub/);
  }),
);

const unbalancedSearches = [
  { name: "closes a group it never opened", query: "is:issue ) OR ( repo:cli/cli" },
  { name: "leaves a group open", query: "(label:bug OR label:crash" },
  { name: "leaves a quotation open", query: 'label:"needs triage' },
] as const;

for (const search of unbalancedSearches) {
  it.effect(`rejects an issue search that ${search.name} before calling GitHub`, () =>
    Effect.gen(function* () {
      const error = yield* listIssues({
        projectId,
        state: "open",
        query: search.query,
        limit: 10,
      }).pipe(Effect.provide(mockReads({ execute: forbidGitHub })), Effect.flip);
      assert.equal(error._tag, "IssueReadError");
      assert.equal(error.message, "Close every parenthesis and quotation mark in the search.");
    }),
  );
}

it.effect(
  "passes balanced groups, quoted parentheses and sort qualifiers to GitHub unchanged",
  () =>
    Effect.gen(function* () {
      const searches: Array<string | undefined> = [];
      const query = '(label:bug OR label:crash) "fails on ) and (" sort:updated-desc';
      const result = yield* listIssues({
        projectId,
        state: "open",
        query: ` ${query} `,
        limit: 10,
      }).pipe(
        Effect.provide(
          mockReads({
            execute: ({ args }) => {
              if (args[0] === "repo") return repositoryOutput();
              searches.push(args[args.indexOf("--search") + 1]);
              return output([summary]);
            },
          }),
        ),
      );
      assert.deepStrictEqual(searches, [query]);
      assert.equal(result.issues.length, 1);
    }),
);

it.effect("rejects an issue list page that contains an issue from another repository", () =>
  Effect.gen(function* () {
    const error = yield* listIssues({ projectId, state: "open", query: "", limit: 1 }).pipe(
      Effect.provide(
        mockReads({
          execute: ({ args }) =>
            args[0] === "repo"
              ? repositoryOutput()
              : output([
                  summary,
                  // Past the page limit, so filtering it out would still misreport hasMore.
                  { ...summary, number: 3, url: "https://github.com/cli/cli/issues/3" },
                ]),
        }),
      ),
      Effect.flip,
    );
    assert.equal(error._tag, "IssueReadError");
    assert.match(error.message, /another repository/);
  }),
);

it.effect("accepts issue URLs that differ from the repository URL only in letter case", () =>
  Effect.gen(function* () {
    const result = yield* listIssues({ projectId, state: "open", query: "", limit: 10 }).pipe(
      Effect.provide(
        mockReads({
          execute: ({ args }) =>
            args[0] === "repo"
              ? output({ nameWithOwner: "Acme/App", url: "https://github.com/Acme/App" })
              : output([summary]),
        }),
      ),
    );
    assert.equal(result.repository, "Acme/App");
    assert.equal(result.issues[0]?.url, "https://github.com/acme/app/issues/1");
  }),
);

const mismatchedDetails = [
  {
    name: "from another repository",
    detail: { ...detailResponse, url: "https://github.com/cli/cli/issues/1" },
  },
  {
    name: "with a different issue number",
    detail: { ...detailResponse, ...summaryNumbered(2) },
  },
  {
    name: "that is a pull request",
    detail: { ...detailResponse, url: "https://github.com/acme/app/pull/1" },
  },
] as const;

for (const mismatch of mismatchedDetails) {
  it.effect(`rejects an issue detail ${mismatch.name}`, () =>
    Effect.gen(function* () {
      const error = yield* readIssueDetail({ projectId, number: 1 }).pipe(
        Effect.provide(
          mockReads({
            execute: ({ args }) =>
              args[0] === "repo" ? repositoryOutput() : output(mismatch.detail),
          }),
        ),
        Effect.flip,
      );
      assert.equal(error._tag, "IssueReadError");
      assert.equal(error.message, "GitHub did not return issue #1 of acme/app.");
    }),
  );
}

// Issues pane, phase 3 fence. The measured case: the project's recorded identity names the
// upstream repository and carries no web URL, while `gh repo view` without an argument would read
// the checkout's default remote, a fork. A known identity must decide the repository.
const upstreamIdentityProject = Option.some<OrchestrationProjectShell>({
  ...project,
  workspaceRoot: "/home/dev/repos/fork-checkout",
  repositoryIdentity: {
    canonicalKey: "github.com/pingdotgg/t3code",
    provider: "github",
    owner: "pingdotgg",
    name: "t3code",
    locator: {
      source: "git-remote",
      remoteName: "upstream",
      remoteUrl: "git@github.com:pingdotgg/t3code.git",
    },
  },
});

/** `gh repo view` as a checkout with a fork as its default remote answers it. */
function forkCheckoutRepositoryView(args: ReadonlyArray<string>) {
  const positional = args[2] !== undefined && !args[2].startsWith("--") ? args[2] : null;
  return positional !== null && /pingdotgg\/t3code(?:\.git)?\/?$/iu.test(positional)
    ? output({ nameWithOwner: "pingdotgg/t3code", url: "https://github.com/pingdotgg/t3code" })
    : output({
        nameWithOwner: "mesura-hq/mesura-code",
        url: "https://github.com/mesura-hq/mesura-code",
      });
}

it.effect(
  "issues phase 3 fence: a known GitHub identity without a web URL decides the listed repository over the checkout default",
  () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const result = yield* listIssues({ projectId, state: "open", query: "", limit: 10 }).pipe(
        Effect.provide(
          mockReads({
            project: upstreamIdentityProject,
            execute: ({ args }) => {
              calls.push(args);
              return args[0] === "repo"
                ? forkCheckoutRepositoryView(args)
                : output([
                    {
                      ...summary,
                      number: 17402,
                      url: "https://github.com/pingdotgg/t3code/issues/17402",
                    },
                  ]);
            },
          }),
        ),
      );
      assert.equal(result.repository, "pingdotgg/t3code");
      assert.equal(result.repositoryUrl, "https://github.com/pingdotgg/t3code");
      assert.isFalse(calls.some((args) => args.some((arg) => /mesura-hq/iu.test(arg))));
    }),
);

it.effect(
  "issues phase 3 fence: a known GitHub identity without a web URL decides the detail repository over the checkout default",
  () =>
    Effect.gen(function* () {
      const detail = yield* readIssueDetail({ projectId, number: 17402 }).pipe(
        Effect.provide(
          mockReads({
            project: upstreamIdentityProject,
            execute: ({ args }) =>
              args[0] === "repo"
                ? forkCheckoutRepositoryView(args)
                : output({
                    ...detailResponse,
                    number: 17402,
                    url: "https://github.com/pingdotgg/t3code/issues/17402",
                    comments: [],
                  }),
          }),
        ),
      );
      assert.equal(detail.url, "https://github.com/pingdotgg/t3code/issues/17402");
    }),
);

it.effect(
  "issues phase 3 fence: GitHub naming another repository than the known identity is an error, not a substitute",
  () =>
    Effect.gen(function* () {
      const error = yield* listIssues({ projectId, state: "open", query: "", limit: 10 }).pipe(
        Effect.provide(
          mockReads({
            project: upstreamIdentityProject,
            execute: ({ args }) =>
              args[0] === "repo"
                ? output({
                    nameWithOwner: "mesura-hq/mesura-code",
                    url: "https://github.com/mesura-hq/mesura-code",
                  })
                : output([]),
          }),
        ),
        Effect.flip,
      );
      assert.equal(error._tag, "IssueReadError");
    }),
);

it.effect(
  "issues phase 3 guard: a project with no recorded identity still reads the checkout's own repository",
  () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const result = yield* listIssues({ projectId, state: "open", query: "", limit: 10 }).pipe(
        Effect.provide(
          mockReads({
            project: Option.some({ ...project, repositoryIdentity: null }),
            execute: ({ args }) => {
              calls.push(args);
              return args[0] === "repo" ? repositoryOutput() : output([summary]);
            },
          }),
        ),
      );
      assert.equal(result.repository, "acme/app");
      assert.deepStrictEqual(calls[0], ["repo", "view", "--json", "nameWithOwner,url"]);
    }),
);

/** The record GitHub's REST `repos/{owner}/{repo}/issues/{number}` endpoint returns. */
function restIssueRecord(
  number: number,
  options: { pullRequest?: boolean; repository?: string } = {},
) {
  const repository = options.repository ?? "acme/app";
  return {
    number,
    title: options.pullRequest ? "A pull request" : "An issue",
    html_url: `https://github.com/${repository}/${options.pullRequest ? "pull" : "issues"}/${number}`,
    state: "open",
    ...(options.pullRequest
      ? {
          pull_request: {
            url: `https://api.github.com/repos/${repository}/pulls/${number}`,
            html_url: `https://github.com/${repository}/pull/${number}`,
          },
        }
      : {}),
  };
}

it.effect(
  "issues phase 3 fence: reference resolution classifies an issue from the repository issues endpoint",
  () =>
    Effect.gen(function* () {
      const calls: Array<ExecuteInput> = [];
      const result = yield* resolveIssueReference({ projectId, number: 7 }).pipe(
        Effect.provide(
          mockReads({
            execute: (input) => {
              calls.push(input);
              return input.args[0] === "repo" ? repositoryOutput() : output(restIssueRecord(7));
            },
          }),
        ),
      );
      assert.deepStrictEqual(result, {
        kind: "issue",
        number: 7,
        url: "https://github.com/acme/app/issues/7",
        repository: "acme/app",
      });
      const read = calls.find((call) => call.args[0] === "api");
      assert.isDefined(read);
      assert.isTrue(read!.args.some((arg) => /repos\/acme\/app\/issues\/7$/iu.test(arg)));
      assert.isTrue(Number.isFinite(read!.maxOutputBytes));
      assert.isTrue(calls.every((call) => call.cwd === "/repo"));
    }),
);

it.effect(
  "issues phase 3 fence: reference resolution classifies a pull request that GitHub serves under issues",
  () =>
    Effect.gen(function* () {
      const result = yield* resolveIssueReference({ projectId, number: 17404 }).pipe(
        Effect.provide(
          mockReads({
            execute: ({ args }) =>
              args[0] === "repo"
                ? repositoryOutput()
                : output(restIssueRecord(17404, { pullRequest: true })),
          }),
        ),
      );
      assert.deepStrictEqual(result, {
        kind: "pull-request",
        number: 17404,
        url: "https://github.com/acme/app/pull/17404",
        repository: "acme/app",
      });
    }),
);

it.effect(
  "issues phase 3 fence: reference resolution reads the known identity's repository, not the checkout default",
  () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const result = yield* resolveIssueReference({ projectId, number: 17402 }).pipe(
        Effect.provide(
          mockReads({
            project: upstreamIdentityProject,
            execute: ({ args }) => {
              calls.push(args);
              return args[0] === "repo"
                ? forkCheckoutRepositoryView(args)
                : output(restIssueRecord(17402, { repository: "pingdotgg/t3code" }));
            },
          }),
        ),
      );
      assert.equal(result.url, "https://github.com/pingdotgg/t3code/issues/17402");
      assert.isFalse(calls.some((args) => args.some((arg) => /mesura-hq/iu.test(arg))));
    }),
);

const mismatchedReferences = [
  { name: "from another repository", record: restIssueRecord(7, { repository: "cli/cli" }) },
  { name: "with a different number", record: restIssueRecord(8) },
  { name: "without a web URL", record: { number: 7, state: "open" } },
] as const;

for (const mismatch of mismatchedReferences) {
  it.effect(`issues phase 3 fence: reference resolution rejects a record ${mismatch.name}`, () =>
    Effect.gen(function* () {
      const error = yield* resolveIssueReference({ projectId, number: 7 }).pipe(
        Effect.provide(
          mockReads({
            execute: ({ args }) =>
              args[0] === "repo" ? repositoryOutput() : output(mismatch.record),
          }),
        ),
        Effect.flip,
      );
      assert.equal(error._tag, "IssueReadError");
    }),
  );
}

for (const failure of gitHubCliFailures) {
  it.effect(
    `issues phase 3 fence: reference resolution reports ${failure.name} instead of guessing an issue`,
    () =>
      Effect.gen(function* () {
        const error = yield* resolveIssueReference({ projectId, number: 7 }).pipe(
          Effect.provide(
            mockReads({
              execute: ({ args }) =>
                args[0] === "repo" ? repositoryOutput() : Effect.fail(failure.error),
            }),
          ),
          Effect.flip,
        );
        assert.equal(error._tag, "IssueReadError");
        assert.match(error.message, failure.remedy);
      }),
  );
}

it.effect(
  "issues phase 3 fence: reference resolution reports an over-long record as an error",
  () =>
    Effect.gen(function* () {
      const error = yield* resolveIssueReference({ projectId, number: 7 }).pipe(
        Effect.provide(
          mockReads({
            execute: ({ args }) =>
              args[0] === "repo" ? repositoryOutput() : truncatedOutput('{"number":7'),
          }),
        ),
        Effect.flip,
      );
      assert.equal(error._tag, "IssueReadError");
    }),
);

it.effect(
  "issues phase 3 fence: reference resolution refuses other providers and missing projects before calling GitHub",
  () =>
    Effect.gen(function* () {
      for (const missing of [Option.none<OrchestrationProjectShell>(), gitlabProject]) {
        const error = yield* resolveIssueReference({ projectId, number: 7 }).pipe(
          Effect.provide(mockReads({ project: missing, execute: forbidGitHub })),
          Effect.flip,
        );
        assert.equal(error._tag, "IssueReadError");
      }
    }),
);

it.effect(
  "issues phase 3 fence: reference resolution reads the null pull_request field GitHub's jq projection writes for an issue",
  () =>
    Effect.gen(function* () {
      // The live shape `gh api --jq '{…, pull_request: .pull_request}'` printed for issue #17402.
      const result = yield* resolveIssueReference({ projectId, number: 7 }).pipe(
        Effect.provide(
          mockReads({
            execute: ({ args }) =>
              args[0] === "repo"
                ? repositoryOutput()
                : output({
                    html_url: "https://github.com/acme/app/issues/7",
                    number: 7,
                    pull_request: null,
                  }),
          }),
        ),
      );
      assert.equal(result.kind, "issue");
    }),
);

// Issues phase 3 rework (P1-1): a known identity that names its repository only through its
// canonical key still decides the repository; one whose fields disagree is refused before `gh`.
const canonicalOnlyIdentityProject = Option.some<OrchestrationProjectShell>({
  ...project,
  workspaceRoot: "/home/dev/repos/fork-checkout",
  repositoryIdentity: {
    canonicalKey: "github.com/pingdotgg/t3code",
    provider: "github",
    locator: {
      source: "git-remote",
      remoteName: "upstream",
      remoteUrl: "git@github.com:pingdotgg/t3code.git",
    },
  },
});

it.effect(
  "issues phase 3 regression: a canonical-only GitHub identity decides list, detail and reference reads over the checkout default",
  () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const reads = mockReads({
        project: canonicalOnlyIdentityProject,
        execute: ({ args }) => {
          calls.push(args);
          if (args[0] === "repo") return forkCheckoutRepositoryView(args);
          if (args[0] === "api")
            return output(restIssueRecord(17402, { repository: "pingdotgg/t3code" }));
          return args[1] === "list"
            ? output([
                {
                  ...summary,
                  number: 17402,
                  url: "https://github.com/pingdotgg/t3code/issues/17402",
                },
              ])
            : output({
                ...detailResponse,
                number: 17402,
                url: "https://github.com/pingdotgg/t3code/issues/17402",
                comments: [],
              });
        },
      });
      const list = yield* listIssues({ projectId, state: "open", query: "", limit: 10 }).pipe(
        Effect.provide(reads),
      );
      const detail = yield* readIssueDetail({ projectId, number: 17402 }).pipe(
        Effect.provide(reads),
      );
      const reference = yield* resolveIssueReference({ projectId, number: 17402 }).pipe(
        Effect.provide(reads),
      );
      assert.equal(list.repository, "pingdotgg/t3code");
      assert.equal(detail.url, "https://github.com/pingdotgg/t3code/issues/17402");
      assert.equal(reference.repository, "pingdotgg/t3code");
      assert.isFalse(calls.some((args) => args.some((arg) => /mesura-hq/iu.test(arg))));
    }),
);

const contradictoryIdentities = [
  {
    name: "an owner and name that name another repository than the canonical key",
    identity: { owner: "mesura-hq", name: "mesura-code" },
  },
  {
    name: "a display name that names another repository than the canonical key",
    identity: { displayName: "mesura-hq/mesura-code" },
  },
  {
    name: "a web URL that names another repository than the canonical key",
    identity: { webUrl: "https://github.com/mesura-hq/mesura-code" },
  },
  {
    name: "a web URL on another host than the canonical key",
    identity: { webUrl: "https://github.acme.test/pingdotgg/t3code" },
  },
  {
    name: "a canonical key that names no repository",
    identity: { canonicalKey: "github.com" },
  },
] as const;

for (const contradiction of contradictoryIdentities) {
  it.effect(
    `issues phase 3 regression: an identity with ${contradiction.name} is refused for every read before calling GitHub`,
    () =>
      Effect.gen(function* () {
        const identityProject = Option.some<OrchestrationProjectShell>({
          ...project,
          repositoryIdentity: {
            ...(canonicalOnlyIdentityProject.pipe(Option.getOrThrow).repositoryIdentity ?? {
              canonicalKey: "",
              locator: { source: "git-remote", remoteName: "origin", remoteUrl: "x" },
            }),
            ...contradiction.identity,
          },
        });
        const reads = mockReads({ project: identityProject, execute: forbidGitHub });
        const errors = [
          yield* listIssues({ projectId, state: "open", query: "", limit: 10 }).pipe(
            Effect.provide(reads),
            Effect.flip,
          ),
          yield* readIssueDetail({ projectId, number: 1 }).pipe(Effect.provide(reads), Effect.flip),
          yield* resolveIssueReference({ projectId, number: 1 }).pipe(
            Effect.provide(reads),
            Effect.flip,
          ),
        ];
        for (const error of errors) assert.equal(error._tag, "IssueReadError");
      }),
  );
}
