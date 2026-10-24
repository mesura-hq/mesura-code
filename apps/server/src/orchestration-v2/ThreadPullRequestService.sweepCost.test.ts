/**
 * What a steady-state pull-request sweep costs in spawned processes when every
 * thread group's lookup fails for a cause a retry cannot change. Entry point:
 * `ThreadPullRequestService.make` started through
 * `ThreadPullRequestService.testkit.ts`, over the real GitManager, repository
 * identity resolver and source control registry of `GitManager.testkit.ts`
 * against a real repository. The remote is on GitHub, but the registry has no
 * providers. Each lookup ends in "No github source control provider is
 * registered.", as it does in production when that provider is unavailable.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  makeGitManagerOverRealGit,
  makeTrackedBranchesRepository,
} from "../git/GitManager.testkit.ts";
import {
  makeSweepHarness,
  sweepProjectShell,
  sweepThreadShell,
} from "./ThreadPullRequestService.testkit.ts";

const GROUPS = 50;
/** Sweeps before the measured window: long enough for any backoff to settle. */
const WARM_UP_SWEEPS = 60;
const MEASURED_SWEEPS = 30;
/**
 * Processes per steady-state sweep at the base commit 87ef81a2be, measured with
 * the original unregistered-provider fixture (50 groups, sweeps 61-90). The
 * base looks every group up on every sweep.
 */
const BASE_PROCESSES_PER_SWEEP = 157;

describe("PR sweep process cost", () => {
  // oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- The process-count regression runs 90 sweeps over 50 real Git branches; retain the existing subprocess budget.
  it.effect(
    "PR sweep cost: 50 groups that cannot be looked up spawn at least 90% fewer processes per sweep than the base",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const branches = Array.from(
            { length: GROUPS },
            (_, index) => `feature/sweep-${String(index).padStart(2, "0")}`,
          );
          const repo = yield* makeTrackedBranchesRepository({
            // Unknown hosts return an empty result. A recognized host without a
            // registered provider must fail so this fixture measures failure backoff.
            remoteUrl: "https://github.com/acme/widgets.git",
            branches,
          });
          const { manager, repositoryIdentities, spawned } = yield* makeGitManagerOverRealGit();
          const harness = yield* makeSweepHarness({
            threads: branches.map((branch, index) =>
              sweepThreadShell(`thread-sweep-${index}`, { branch }),
            ),
            project: sweepProjectShell(repo),
            git: manager,
            repositoryIdentities,
          });

          yield* harness.start;
          yield* harness.sweeps(WARM_UP_SWEEPS);
          // The fixture is what it claims: every group's lookup failed for want of a provider.
          expect(
            harness.logs.some((log) =>
              log.message.includes("No github source control provider is registered."),
            ),
          ).toBe(true);
          const before = spawned.length;
          yield* harness.sweeps(MEASURED_SWEEPS);
          const perSweep = (spawned.length - before) / MEASURED_SWEEPS;
          // Which git subcommands the window spent, for the failure message.
          const breakdown: Record<string, number> = {};
          for (const process of spawned.slice(before)) {
            const subcommand = process.args.find(
              (arg, index) => !arg.startsWith("-") && process.args[index - 1] !== "-C",
            );
            const name = `${process.command} ${subcommand ?? ""}`;
            breakdown[name] = (breakdown[name] ?? 0) + 1;
          }
          expect(perSweep, JSON.stringify(breakdown)).toBeLessThanOrEqual(
            BASE_PROCESSES_PER_SWEEP * 0.1,
          );
        }),
      ),
    { timeout: 600_000 },
  );
});
