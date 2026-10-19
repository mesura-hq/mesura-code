/**
 * The background pull-request sweep backs off thread groups whose lookup fails
 * for a cause a retry cannot change, and keeps its per-sweep refresh for the
 * rest. Entry point: `ThreadPullRequestService.make` started through
 * `ThreadPullRequestService.testkit.ts`, which runs the startup backfill and
 * then one sweep per minute of `TestClock` time, as the server does.
 */
import {
  SourceControlProviderError,
  VcsProcessExitError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as BitbucketApi from "@t3tools/source-control-bitbucket/server/BitbucketApi";
import * as ForgejoCli from "@t3tools/source-control-forgejo/server/ForgejoCli";
import * as GitLabCli from "@t3tools/source-control-gitlab/server/GitLabCli";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import type * as GitManager from "../git/GitManager.ts";
import type * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import {
  makeSweepHarness,
  sweepDomainEvent,
  sweepProjectShell,
  sweepThreadShell,
  type SweepTriggerEvent,
} from "./ThreadPullRequestService.testkit.ts";

const WORKSPACE = "/workspace/project";
const MINUTE = 60_000;
const LOOKUP_FAILED = "thread branch pull request lookup failed";

const githubIdentity = {
  resolve: () =>
    Effect.succeed({
      canonicalKey: "github.com/acme/widgets",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:acme/widgets.git",
      },
      provider: "github" as const,
      displayName: "acme/widgets",
      owner: "acme",
      name: "widgets",
    }),
} satisfies RepositoryIdentityResolver.RepositoryIdentityResolver["Service"];

const unsupportedHostIdentity = {
  resolve: () =>
    Effect.succeed({
      canonicalKey: "git.example.invalid/acme/widgets",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://git.example.invalid/acme/widgets.git",
      },
      displayName: "acme/widgets",
      owner: "acme",
      name: "widgets",
    }),
} satisfies RepositoryIdentityResolver.RepositoryIdentityResolver["Service"];

type LookupFailure = SourceControlProviderError;

/** A Forgejo lookup failure as `ForgejoSourceControlProvider` reports it. */
const forgejoFailure = (
  reason: "authentication" | "forbidden" | "rate-limit",
  detail: string,
): LookupFailure =>
  new SourceControlProviderError({
    provider: "forgejo",
    operation: "listChangeRequests",
    command: "tea",
    cwd: WORKSPACE,
    detail,
    cause: new ForgejoCli.ForgejoCliError({ command: "tea", cwd: WORKSPACE, detail, reason }),
  });

/** A Bitbucket lookup failure as `BitbucketSourceControlProvider` reports it. */
const bitbucketFailure = (status: number): LookupFailure =>
  new SourceControlProviderError({
    provider: "bitbucket",
    operation: "listChangeRequests",
    cwd: WORKSPACE,
    detail: "Failed to list change requests.",
    cause: new BitbucketApi.BitbucketResponseError({
      operation: "listPullRequests",
      status,
      responseBodyLength: 0,
    }),
  });

/** Failures a retry cannot change, in the shapes the providers produce them. */
const PERMANENT_FAILURES: ReadonlyArray<readonly [string, () => LookupFailure]> = [
  [
    "no source-control provider for the remote",
    () =>
      new SourceControlProviderError({
        provider: "unknown",
        operation: "listChangeRequests",
        cwd: WORKSPACE,
        detail: "No unknown source control provider is registered.",
      }),
  ],
  [
    "a GitHub credential that GitHub refuses",
    () =>
      new SourceControlProviderError({
        provider: "github",
        operation: "listChangeRequests",
        cwd: WORKSPACE,
        detail: "GitHub is not authenticated. Run `gh auth login` (or set GH_TOKEN) and retry.",
        cause: new GitHubApi.GitHubApiAuthenticationError({
          host: "github.com",
          operation: "listChangeRequests",
        }),
      }),
  ],
  [
    "no GitHub credential on the server",
    () =>
      new SourceControlProviderError({
        provider: "github",
        operation: "listChangeRequests",
        cwd: WORKSPACE,
        detail:
          "No GitHub credential on the server. Set GH_TOKEN, or install the GitHub CLI and run `gh auth login`.",
        cause: new GitHubCredentials.GitHubCliMissingError({ host: "github.com" }),
      }),
  ],
  [
    "a GitHub CLI with no login for the host",
    () =>
      new SourceControlProviderError({
        provider: "github",
        operation: "listChangeRequests",
        cwd: WORKSPACE,
        detail: "No GitHub credential for github.com: run `gh auth login --hostname github.com`.",
        cause: new GitHubCredentials.GitHubNotSignedInError({ host: "github.com" }),
      }),
  ],
  [
    "a GitLab CLI that is not logged in",
    () => {
      const cause = new GitLabCli.GitLabCliAuthenticationError({
        operation: "execute",
        command: "glab",
        cwd: WORKSPACE,
        cause: new VcsProcessExitError({
          operation: "GitLabCli.execute",
          command: "glab",
          cwd: WORKSPACE,
          exitCode: 1,
          detail: "glab exited with code 1.",
          failureKind: "authentication",
        }),
      });
      return new SourceControlProviderError({
        provider: "gitlab",
        operation: "listChangeRequests",
        command: "glab",
        cwd: WORKSPACE,
        detail: cause.detail,
        cause,
      });
    },
  ],
  [
    "a Forgejo login that is not authenticated",
    () => forgejoFailure("authentication", "Forgejo rejected the credential."),
  ],
  ["a Bitbucket credential answered with HTTP 401", () => bitbucketFailure(401)],
];

/** Failures the next attempt can clear. */
const TRANSIENT_FAILURES: ReadonlyArray<readonly [string, () => LookupFailure]> = [
  [
    "GitHub unreachable over the network",
    () =>
      new SourceControlProviderError({
        provider: "github",
        operation: "listChangeRequests",
        cwd: WORKSPACE,
        detail: "Could not reach GitHub at github.com.",
        cause: new GitHubApi.GitHubApiRequestError({
          host: "github.com",
          operation: "listChangeRequests",
          cause: new TypeError("fetch failed"),
        }),
      }),
  ],
  [
    "a provider CLI that timed out",
    () =>
      new SourceControlProviderError({
        provider: "gitlab",
        operation: "listChangeRequests",
        command: "glab",
        cwd: WORKSPACE,
        detail: "GitLab CLI command failed.",
        cause: new VcsProcessTimeoutError({
          operation: "GitLabCli.execute",
          command: "glab",
          cwd: WORKSPACE,
          timeoutMs: 30_000,
        }),
      }),
  ],
  [
    "a Forgejo answer that forbids the repository",
    () => forgejoFailure("forbidden", "Forgejo refused access to the repository."),
  ],
  ["a Forgejo rate limit", () => forgejoFailure("rate-limit", "Forgejo rate limit exceeded.")],
  ["a Bitbucket answer with HTTP 403", () => bitbucketFailure(403)],
  ["a Bitbucket rate limit (HTTP 429)", () => bitbucketFailure(429)],
];

interface LookupAttempt {
  readonly branch: string;
  readonly atMinute: number;
}

/**
 * A git fake whose answer per branch the test can change. Records each
 * `branchPullRequest` call with the test-clock minute it happened at.
 */
function makeLookupGit(initial: Record<string, LookupFailure | null | (() => LookupFailure)>): {
  readonly git: Pick<GitManager.GitManager["Service"], "branchPullRequest">;
  readonly attempts: Array<LookupAttempt>;
  readonly answer: (branch: string, next: LookupFailure | null | (() => LookupFailure)) => void;
} {
  const answers = new Map(Object.entries(initial));
  const attempts: Array<LookupAttempt> = [];
  return {
    attempts,
    answer: (branch, next) => {
      answers.set(branch, next);
    },
    git: {
      branchPullRequest: ({ branch }) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          attempts.push({ branch, atMinute: Math.round(now / MINUTE) });
          const answer = answers.get(branch) ?? null;
          if (answer === null) return null;
          return yield* typeof answer === "function" ? answer() : answer;
        }),
    },
  };
}

const minutesOf = (attempts: ReadonlyArray<LookupAttempt>, branch: string) =>
  attempts.filter((attempt) => attempt.branch === branch).map((attempt) => attempt.atMinute);

const gapsOf = (minutes: ReadonlyArray<number>) =>
  minutes.slice(1).map((minute, index) => minute - minutes[index]!);

describe("PR sweep backoff for lookups a retry cannot change", () => {
  it.effect.each(PERMANENT_FAILURES)(
    "PR sweep backoff: a group failing with %s backs off to at least 30 minutes",
    ([, failure]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const thread = sweepThreadShell("thread-permanent", { branch: "feature/permanent" });
          const lookups = makeLookupGit({ "feature/permanent": failure });
          const harness = yield* makeSweepHarness({
            threads: [thread],
            project: sweepProjectShell(WORKSPACE),
            git: lookups.git,
            repositoryIdentities: githubIdentity,
          });
          yield* harness.start;
          yield* harness.sweeps(180);

          const minutes = minutesOf(lookups.attempts, "feature/permanent");
          const gaps = gapsOf(minutes);
          // Not on every sweep: 181 passes ran in these three hours.
          expect(minutes.length).toBeLessThan(181 / 4);
          // The wait between attempts never shrinks, and it reaches 30 minutes.
          expect(gaps.every((gap, index) => index === 0 || gap >= gaps[index - 1]!)).toBe(true);
          expect(gaps.at(-1)).toBeGreaterThanOrEqual(30);
        }),
      ),
  );

  it.effect("PR sweep backoff: an unsupported host's group backs off like a missing provider", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = sweepThreadShell("thread-unsupported-host", {
          branch: "feature/self-hosted",
        });
        const lookups = makeLookupGit({ "feature/self-hosted": PERMANENT_FAILURES[0]![1] });
        const harness = yield* makeSweepHarness({
          threads: [thread],
          project: sweepProjectShell(WORKSPACE),
          git: lookups.git,
          repositoryIdentities: unsupportedHostIdentity,
        });
        yield* harness.start;
        yield* harness.sweeps(120);

        const gaps = gapsOf(minutesOf(lookups.attempts, "feature/self-hosted"));
        expect(gaps.at(-1)).toBeGreaterThanOrEqual(30);
      }),
    ),
  );

  it.effect("PR sweep backoff: one failing group does not slow its healthy neighbour", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failing = sweepThreadShell("thread-failing", { branch: "feature/failing" });
        const healthy = sweepThreadShell("thread-healthy", { branch: "feature/healthy" });
        const lookups = makeLookupGit({
          "feature/failing": PERMANENT_FAILURES[0]![1],
          "feature/healthy": null,
        });
        const harness = yield* makeSweepHarness({
          threads: [failing, healthy],
          project: sweepProjectShell(WORKSPACE),
          git: lookups.git,
          repositoryIdentities: githubIdentity,
        });
        yield* harness.start;
        yield* harness.sweeps(60);

        expect(minutesOf(lookups.attempts, "feature/healthy")).toHaveLength(61);
        expect(minutesOf(lookups.attempts, "feature/failing").length).toBeLessThan(61 / 4);
      }),
    ),
  );

  const TRIGGERS: ReadonlyArray<readonly [SweepTriggerEvent, string]> = [
    ["checkpoint.captured", "a checkpoint is captured"],
    ["run.completed", "a run completes"],
    ["thread.unarchived", "the thread is unarchived"],
    ["thread.metadata-updated", "the thread's branch changes"],
  ];

  it.effect.each(TRIGGERS)(
    "PR sweep backoff: a backed-off group is looked up at once when %s",
    ([kind]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const thread = sweepThreadShell("thread-event", { branch: "feature/event" });
          const lookups = makeLookupGit({
            "feature/event": PERMANENT_FAILURES[0]![1],
            "feature/event-renamed": PERMANENT_FAILURES[0]![1],
          });
          const harness = yield* makeSweepHarness({
            threads: [thread],
            project: sweepProjectShell(WORKSPACE),
            git: lookups.git,
            repositoryIdentities: githubIdentity,
          });
          yield* harness.start;
          yield* harness.sweeps(90);
          // Backed off: the last ten sweeps did not look the group up.
          const before = lookups.attempts.length;
          yield* harness.sweeps(10);
          expect(lookups.attempts.length).toBe(before);

          const changed =
            kind === "thread.metadata-updated"
              ? { ...thread, branch: "feature/event-renamed" }
              : kind === "thread.unarchived"
                ? { ...thread, archivedAt: null }
                : thread;
          if (kind === "thread.unarchived") {
            harness.setThreads([{ ...thread, archivedAt: thread.createdAt }]);
            yield* harness.sweep;
          }
          const atEvent = lookups.attempts.length;
          harness.setThreads([changed]);
          yield* harness.publish(sweepDomainEvent(kind, changed));

          // The event's own pass looked it up, with no clock movement.
          expect(lookups.attempts.slice(atEvent).map((attempt) => attempt.branch)).toEqual([
            changed.branch,
          ]);
        }),
      ),
  );

  it.effect(
    "PR sweep backoff: a group returns to every-sweep refresh once its lookup succeeds",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const thread = sweepThreadShell("thread-recovers", { branch: "feature/recovers" });
          const lookups = makeLookupGit({ "feature/recovers": PERMANENT_FAILURES[2]![1] });
          const harness = yield* makeSweepHarness({
            threads: [thread],
            project: sweepProjectShell(WORKSPACE),
            git: lookups.git,
            repositoryIdentities: githubIdentity,
          });
          yield* harness.start;
          yield* harness.sweeps(90);
          const backedOff = lookups.attempts.length;
          yield* harness.sweeps(10);
          expect(lookups.attempts.length).toBe(backedOff);

          // The developer runs `gh auth login`; the next finished run asks again.
          lookups.answer("feature/recovers", null);
          yield* harness.publish(sweepDomainEvent("run.completed", thread));
          const recovered = lookups.attempts.length;
          yield* harness.sweeps(5);
          expect(lookups.attempts.length - recovered).toBe(5);
        }),
      ),
  );
});

describe("PR sweep warnings for lookups a retry cannot change", () => {
  it.effect("PR sweep warnings: a failing group warns once per backoff step", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = sweepThreadShell("thread-warns", { branch: "feature/warns" });
        const lookups = makeLookupGit({ "feature/warns": PERMANENT_FAILURES[0]![1] });
        const harness = yield* makeSweepHarness({
          threads: [thread],
          project: sweepProjectShell(WORKSPACE),
          git: lookups.git,
          repositoryIdentities: githubIdentity,
        });
        yield* harness.start;
        yield* harness.sweeps(180);

        const warnings = harness.logs.filter((log) => log.message.includes(LOOKUP_FAILED));
        // One warning for each attempt the backoff allowed, not one per sweep.
        expect(warnings).toHaveLength(lookups.attempts.length);
        expect(warnings.length).toBeLessThan(181 / 4);
        expect(warnings.every((warning) => warning.message.includes(thread.id))).toBe(true);
      }),
    ),
  );
});

describe("PR sweep refresh that must not change", () => {
  it.effect("PR sweep guard: a group whose lookup succeeds is looked up on every sweep", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = sweepThreadShell("thread-succeeds", { branch: "feature/succeeds" });
        const lookups = makeLookupGit({ "feature/succeeds": null });
        const harness = yield* makeSweepHarness({
          threads: [thread],
          project: sweepProjectShell(WORKSPACE),
          git: lookups.git,
          repositoryIdentities: githubIdentity,
        });
        yield* harness.start;
        yield* harness.sweeps(45);

        expect(minutesOf(lookups.attempts, "feature/succeeds")).toEqual(
          Array.from({ length: 46 }, (_, index) => index),
        );
      }),
    ),
  );

  it.effect.each(TRANSIENT_FAILURES)(
    "PR sweep guard: a group failing with %s is retried on the next sweep",
    ([, failure]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const thread = sweepThreadShell("thread-transient", { branch: "feature/transient" });
          const lookups = makeLookupGit({ "feature/transient": failure });
          const harness = yield* makeSweepHarness({
            threads: [thread],
            project: sweepProjectShell(WORKSPACE),
            git: lookups.git,
            repositoryIdentities: githubIdentity,
          });
          yield* harness.start;
          yield* harness.sweeps(45);

          expect(minutesOf(lookups.attempts, "feature/transient")).toEqual(
            Array.from({ length: 46 }, (_, index) => index),
          );
        }),
      ),
  );

  it.effect("PR sweep guard: a group whose project has no remote is never looked up", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = sweepThreadShell("thread-no-remote", { branch: "feature/no-remote" });
        const lookups = makeLookupGit({ "feature/no-remote": null });
        const harness = yield* makeSweepHarness({
          threads: [thread],
          project: sweepProjectShell(WORKSPACE),
          git: lookups.git,
          repositoryIdentities: { resolve: () => Effect.succeed(null) },
        });
        yield* harness.start;
        yield* harness.sweeps(10);

        expect(lookups.attempts).toEqual([]);
        expect(harness.logs.filter((log) => log.message.includes(LOOKUP_FAILED))).toEqual([]);
      }),
    ),
  );
});
