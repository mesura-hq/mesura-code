import { describe, expect, it } from "@effect/vitest";
import { SourceControlProviderKind, type ChangeRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  makeGitManagerOverRealGit,
  makeTrackedBranchesRepository,
  type SpawnedProcess,
} from "./GitManager.testkit.ts";
import { UseRepositoryStateMemo } from "./repositoryStateMemo.ts";

const BRANCH = "feature/git-state";
const PULL_REQUEST_URL = "https://github.com/acme/widgets/pull/1";

const makeLookup = Effect.fn("GitManagerPrLookupGitStateTest.makeLookup")(function* (
  state: ChangeRequest["state"],
) {
  const repo = yield* makeTrackedBranchesRepository({
    remoteUrl: "https://github.com/acme/widgets.git",
    branches: [BRANCH],
  });
  const providerCalls: Array<string> = [];
  const { manager, spawned } = yield* makeGitManagerOverRealGit({
    listChangeRequests: (input) =>
      Effect.sync((): ReadonlyArray<ChangeRequest> => {
        providerCalls.push(input.headSelector);
        return [
          {
            provider: SourceControlProviderKind.make("github"),
            number: 1,
            title: "Git state PR",
            url: PULL_REQUEST_URL,
            baseRefName: "main",
            headRefName: BRANCH,
            state,
            updatedAt: Option.none(),
          },
        ];
      }),
  });
  return { repo, manager, spawned, providerCalls };
});

const branchReads = (spawned: ReadonlyArray<SpawnedProcess>) =>
  spawned.filter(
    (process) =>
      process.command === "git" &&
      process.args.includes("for-each-ref") &&
      process.args.includes(`refs/heads/${BRANCH}`),
  );

describe("branch PR lookup freshness with the sweep memo", () => {
  it.effect.each([
    { name: "freshGitState", options: { freshGitState: true }, providerLookups: 1 },
    { name: "refresh", options: { refresh: true }, providerLookups: 2 },
  ])("$name reads live git even when the sweep memo is warm", ({ options, providerLookups }) =>
    Effect.gen(function* () {
      const { repo, manager, spawned, providerCalls } = yield* makeLookup("open");
      const input = { cwd: repo, branch: BRANCH };
      const warm = yield* manager
        .branchPullRequest(input)
        .pipe(Effect.provideService(UseRepositoryStateMemo, true));
      expect(warm?.url).toBe(PULL_REQUEST_URL);
      expect(providerCalls).toHaveLength(1);
      const before = spawned.length;

      const confirmed = yield* manager
        .branchPullRequest(input, options)
        .pipe(Effect.provideService(UseRepositoryStateMemo, true));

      expect(confirmed).toEqual(warm);
      expect(branchReads(spawned.slice(before))).toHaveLength(1);
      expect(providerCalls).toHaveLength(providerLookups);
    }),
  );

  it.effect.each<ChangeRequest["state"]>(["merged", "closed"])(
    "confirms a %s answer against live git while the sweep memo is enabled",
    (state) =>
      Effect.gen(function* () {
        const { repo, manager, spawned, providerCalls } = yield* makeLookup(state);

        const pullRequest = yield* manager
          .branchPullRequest({ cwd: repo, branch: BRANCH })
          .pipe(Effect.provideService(UseRepositoryStateMemo, true));

        expect(pullRequest).toMatchObject({ state, url: PULL_REQUEST_URL });
        expect(branchReads(spawned)).toHaveLength(2);
        expect(providerCalls).toHaveLength(1);
      }),
  );
});
