/**
 * The sweep through the real GitManager, its lookup cache and identity resolver:
 * an event looks a backed-off group up at once even while GitManager caches the
 * failure, a transient failure reaches the provider on every sweep, and a
 * repointed remote makes the next sweep apply the new repository's pull request.
 */
import { describe, expect, it } from "@effect/vitest";
import {
  SourceControlProviderKind,
  ProjectId,
  SourceControlProviderError,
  type ChangeRequest,
} from "@t3tools/contracts";
import * as GitHubRequestPolicy from "../../../../packages/source-control-github/src/server/GitHubRequestPolicy.ts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  makeGitManagerOverRealGit,
  makeTrackedBranchesRepository,
  runGitSync,
} from "../git/GitManager.testkit.ts";
import {
  makeSweepHarness,
  sweepDomainEvent,
  sweepProjectShell,
  sweepThreadShell,
} from "./ThreadPullRequestService.testkit.ts";

const BRANCH = "feature/real-lookup";
const WIDGETS_URL = "https://github.com/acme/widgets.git";
const GADGETS_URL = "https://github.com/acme/gadgets.git";
const MINUTE = 60_000;

const failure = (cause: unknown, detail: string) =>
  new SourceControlProviderError({
    provider: SourceControlProviderKind.make("github"),
    operation: "listChangeRequests",
    cwd: "/workspace",
    detail,
    cause,
  });

const authenticationFailure = () =>
  failure(
    new GitHubRequestPolicy.GitHubApiAuthenticationError({
      host: "github.com",
      operation: "listChangeRequests",
    }),
    "GitHub is not authenticated. Run `gh auth login` (or set GH_TOKEN) and retry.",
  );

const networkFailure = () =>
  failure(
    new GitHubRequestPolicy.GitHubApiRequestError({
      host: "github.com",
      operation: "listChangeRequests",
      cause: new TypeError("fetch failed"),
    }),
    "Could not reach GitHub at github.com.",
  );

const openPullRequest = (repository: string, number: number): ChangeRequest => ({
  provider: SourceControlProviderKind.make("github"),
  number,
  title: `Pull request ${number}`,
  url: `https://github.com/acme/${repository}/pull/${number}`,
  baseRefName: "main",
  headRefName: BRANCH,
  state: "open",
  updatedAt: Option.none(),
});

type ProviderAnswer = (
  remoteUrl: string | undefined,
) => Effect.Effect<ReadonlyArray<ChangeRequest>, SourceControlProviderError>;

/** One thread on a real repository; the provider answers whatever `answer` says now. */
const makeRealLookupSweep = (input: {
  readonly answer: ProviderAnswer;
  readonly linked?: { readonly repository: string; readonly number: number };
}) =>
  Effect.gen(function* () {
    const repo = yield* makeTrackedBranchesRepository({
      remoteUrl: WIDGETS_URL,
      branches: [BRANCH],
    });
    let answer = input.answer;
    const providerMinutes: Array<number> = [];
    const { manager, repositoryIdentities } = yield* makeGitManagerOverRealGit({
      listChangeRequests: (request) =>
        Effect.gen(function* () {
          providerMinutes.push(Math.round((yield* Clock.currentTimeMillis) / MINUTE));
          return yield* answer(request.context?.remoteUrl);
        }),
    });
    const thread = sweepThreadShell("thread-real-lookup", {
      branch: BRANCH,
      ...(input.linked === undefined
        ? {}
        : {
            branchPullRequest: {
              projectId: ProjectId.make("project-1"),
              repository: `acme/${input.linked.repository}`,
              number: input.linked.number,
              url: `https://github.com/acme/${input.linked.repository}/pull/${input.linked.number}`,
            },
          }),
    });
    const harness = yield* makeSweepHarness({
      threads: [thread],
      project: sweepProjectShell(repo),
      git: manager,
      repositoryIdentities,
    });
    yield* harness.start;
    return {
      repo,
      thread,
      harness,
      providerMinutes,
      setAnswer: (next: ProviderAnswer) => {
        answer = next;
      },
    };
  });

describe("PR sweep retry policy through the real GitManager", () => {
  it.effect(
    "PR sweep real lookup: a finished run reaches the provider at once after credentials recover",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sweep = yield* makeRealLookupSweep({
            answer: () => Effect.fail(authenticationFailure()),
          });
          // Attempts at minutes 0, 1, 3, 7 and 15; at 16 the group waits, and
          // GitManager still holds the failure from minute 15 (its TTL is minutes).
          yield* sweep.harness.sweeps(16);
          expect(sweep.providerMinutes.at(-1)).toBe(15);
          const backedOff = sweep.providerMinutes.length;

          // The developer runs `gh auth login`; the next finished run asks again.
          sweep.setAnswer(() => Effect.succeed([]));
          yield* sweep.harness.publish(sweepDomainEvent("run.completed", sweep.thread));
          expect(sweep.providerMinutes.length).toBeGreaterThan(backedOff);
        }),
      ),
  );

  it.effect(
    "PR sweep real lookup: a network failure reaches the provider again on every sweep",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sweep = yield* makeRealLookupSweep({
            answer: () => Effect.fail(networkFailure()),
          });
          yield* sweep.harness.sweeps(8);
          const minutes = new Set(sweep.providerMinutes);
          expect([...minutes].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
        }),
      ),
  );
});

describe("PR sweep remote changes through the real GitManager", () => {
  it.effect(
    "PR sweep real lookup: repointing origin makes the next sweep apply the new repository's pull request",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sweep = yield* makeRealLookupSweep({
            answer: (remoteUrl) =>
              Effect.succeed([
                remoteUrl === GADGETS_URL
                  ? openPullRequest("gadgets", 7)
                  : openPullRequest("widgets", 1),
              ]),
            linked: { repository: "widgets", number: 1 },
          });
          yield* sweep.harness.sweeps(3);
          expect(sweep.harness.dispatched).toEqual([]);

          runGitSync(sweep.repo, ["remote", "set-url", "origin", GADGETS_URL]);
          yield* sweep.harness.sweep;

          const synced = sweep.harness.dispatched.flatMap((command) =>
            command.type === "thread.pull-request.sync" ? [command.branchPullRequest] : [],
          );
          expect(synced).toEqual([
            expect.objectContaining({ repository: "acme/gadgets", number: 7 }),
          ]);
        }),
      ),
  );
});
