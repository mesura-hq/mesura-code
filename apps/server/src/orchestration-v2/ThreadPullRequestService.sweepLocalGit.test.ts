/**
 * What a steady-state pull-request sweep spends in local git processes when
 * every thread group's lookup succeeds and nothing in the repository changed,
 * and that a change to a branch's upstream, the remote URL, a local branch or
 * the default branch still reaches the next sweep. Entry point:
 * `ThreadPullRequestService.make` started through
 * `ThreadPullRequestService.testkit.ts`, over the real GitManager, repository
 * identity resolver and source control registry of `GitManager.testkit.ts`,
 * with a GitHub provider that answers lookups, against a real repository.
 */
import { describe, expect, it } from "@effect/vitest";
import { SourceControlProviderKind, ProjectId, type ChangeRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  makeGitManagerOverRealGit,
  makeTrackedBranchesRepository,
  runGitSync as git,
} from "../git/GitManager.testkit.ts";
import {
  makeSweepHarness,
  sweepProjectShell,
  sweepThreadShell,
} from "./ThreadPullRequestService.testkit.ts";

const GROUPS = 50;
/** Groups below this index have an open pull request; the rest have none. */
const OPEN_PULL_REQUESTS = 25;
const WARM_UP_SWEEPS = 10;
const MEASURED_SWEEPS = 10;
const REMOTE_URL = "https://github.com/acme/widgets.git";
/**
 * Git processes per steady-state sweep at the base commit 87ef81a2be, measured
 * with this fixture (50 groups, 25 with an open pull request, sweeps 11-20).
 */
const BASE_GIT_PROCESSES_PER_SWEEP = 262;
/**
 * Provider lookups per sweep at the base commit, same fixture and window. The
 * open pull requests are re-read every sweep; the rest wait out a longer TTL.
 */
const BASE_PROVIDER_LOOKUPS_PER_SWEEP = 30;

const branchName = (index: number) => `feature/sweep-${String(index).padStart(2, "0")}`;
const pullRequestUrl = (index: number) => `https://github.com/acme/widgets/pull/${index + 1}`;

interface ProviderCall {
  readonly headSelector: string;
  readonly remoteUrl: string | undefined;
}

/** A real repository, 50 thread groups on it, and a provider that answers lookups. */
const makeSucceedingSweep = Effect.gen(function* () {
  const branches = Array.from({ length: GROUPS }, (_, index) => branchName(index));
  const repo = yield* makeTrackedBranchesRepository({ remoteUrl: REMOTE_URL, branches });
  const providerCalls: Array<ProviderCall> = [];
  const { manager, repositoryIdentities, spawned } = yield* makeGitManagerOverRealGit({
    listChangeRequests: (input) =>
      Effect.sync((): ReadonlyArray<ChangeRequest> => {
        providerCalls.push({
          headSelector: input.headSelector,
          remoteUrl: input.context?.remoteUrl,
        });
        const index = branches.findIndex((branch) => input.headSelector.endsWith(branch));
        if (index < 0 || index >= OPEN_PULL_REQUESTS) return [];
        return [
          {
            provider: SourceControlProviderKind.make("github"),
            number: index + 1,
            title: `Pull request ${index + 1}`,
            url: pullRequestUrl(index),
            baseRefName: "main",
            headRefName: branches[index]!,
            state: "open",
            updatedAt: Option.none(),
          },
        ];
      }),
  });
  const harness = yield* makeSweepHarness({
    threads: branches.map((branch, index) =>
      sweepThreadShell(`thread-local-git-${index}`, {
        branch,
        // Already linked, so a steady-state sweep has nothing to dispatch.
        ...(index < OPEN_PULL_REQUESTS
          ? {
              branchPullRequest: {
                projectId: ProjectId.make("project-1"),
                repository: "acme/widgets",
                number: index + 1,
                url: pullRequestUrl(index),
              },
            }
          : {}),
      }),
    ),
    project: sweepProjectShell(repo),
    git: manager,
    repositoryIdentities,
  });
  yield* harness.start;
  yield* harness.sweeps(WARM_UP_SWEEPS);
  return { repo, harness, spawned, providerCalls };
});

/** Provider calls in the next sweep for a branch that has no pull request. */
const callsInNextSweepFor = (sweep: Effect.Success<typeof makeSucceedingSweep>, branch: string) =>
  Effect.gen(function* () {
    const before = sweep.providerCalls.length;
    yield* sweep.harness.sweep;
    return sweep.providerCalls.slice(before).filter((call) => call.headSelector.endsWith(branch));
  });

describe("PR sweep local git cost", () => {
  it.effect(
    "PR sweep local git: 50 succeeding groups spawn at least 80% fewer git processes per steady-state sweep than the base",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sweep = yield* makeSucceedingSweep;
          const before = sweep.spawned.length;
          const providerBefore = sweep.providerCalls.length;
          yield* sweep.harness.sweeps(MEASURED_SWEEPS);
          const window = sweep.spawned.slice(before);
          const breakdown: Record<string, number> = {};
          for (const process of window) {
            const subcommand = process.args.find(
              (arg, index) => !arg.startsWith("-") && process.args[index - 1] !== "-C",
            );
            const name = `${process.command} ${subcommand ?? ""}`;
            breakdown[name] = (breakdown[name] ?? 0) + 1;
          }
          const gitPerSweep =
            window.filter((process) => process.command === "git").length / MEASURED_SWEEPS;
          const providerPerSweep = (sweep.providerCalls.length - providerBefore) / MEASURED_SWEEPS;
          expect(gitPerSweep, JSON.stringify({ providerPerSweep, breakdown })).toBeLessThanOrEqual(
            BASE_GIT_PROCESSES_PER_SWEEP * 0.2,
          );
          // The provider is still consulted as often as at the base.
          expect(providerPerSweep).toBeGreaterThanOrEqual(BASE_PROVIDER_LOOKUPS_PER_SWEEP);
          expect(sweep.harness.logs.filter((log) => log.level === "Warn")).toEqual([]);
        }),
      ),
  );

  it.effect("PR sweep local git guard: a branch's new upstream reaches the next sweep", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sweep = yield* makeSucceedingSweep;
        const branch = branchName(30);
        git(sweep.repo, ["update-ref", "refs/remotes/origin/renamed-upstream", "HEAD"]);
        git(sweep.repo, ["config", `branch.${branch}.merge`, "refs/heads/renamed-upstream"]);
        const before = sweep.providerCalls.length;
        yield* sweep.harness.sweep;
        expect(
          sweep.providerCalls
            .slice(before)
            .some((call) => call.headSelector.endsWith("renamed-upstream")),
        ).toBe(true);
      }),
    ),
  );

  it.effect("PR sweep local git guard: a new remote URL reaches the next sweep", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sweep = yield* makeSucceedingSweep;
        const movedUrl = "https://github.com/acme/gadgets.git";
        git(sweep.repo, ["remote", "set-url", "origin", movedUrl]);
        const calls = yield* callsInNextSweepFor(sweep, branchName(31));
        expect(calls.map((call) => call.remoteUrl)).toContain(movedUrl);
      }),
    ),
  );

  it.effect("PR sweep local git guard: a deleted local branch reaches the next sweep", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sweep = yield* makeSucceedingSweep;
        const branch = branchName(32);
        git(sweep.repo, ["branch", "-D", branch]);
        const calls = yield* callsInNextSweepFor(sweep, branch);
        expect(calls.length).toBeGreaterThan(0);
      }),
    ),
  );

  it.effect("PR sweep local git guard: a new default branch reaches the next sweep", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sweep = yield* makeSucceedingSweep;
        git(sweep.repo, ["update-ref", "refs/remotes/origin/develop", "HEAD"]);
        git(sweep.repo, [
          "symbolic-ref",
          "refs/remotes/origin/HEAD",
          "refs/remotes/origin/develop",
        ]);
        const calls = yield* callsInNextSweepFor(sweep, branchName(33));
        expect(calls.length).toBeGreaterThan(0);
      }),
    ),
  );
});
