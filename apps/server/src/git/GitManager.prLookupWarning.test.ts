/**
 * The "PR lookup failed; keeping last known PR state." warning is written once
 * per lookup attempt, not once per remote status poll. The VCS remote status
 * poller (`VcsStatusBroadcaster`, every 30 seconds by default) reads remote
 * status for the cwd a client watches; a failed lookup is cached with
 * `prLookupFailureTtl`, and every poll inside that window replays it. Entry
 * point: `GitManager.remoteStatus` over real git (`GitManager.testkit.ts`), on
 * a repository whose registered source control provider rejects lookups.
 */
import { describe, expect, it } from "@effect/vitest";
import { SourceControlProviderError, SourceControlProviderKind } from "@t3tools/contracts";
import type { SourceControlProvider } from "@t3tools/source-control-core/server/SourceControlProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";

import { prLookupFailureTtl } from "./GitManager.ts";
import { makeGitManagerOverRealGit, makeTrackedBranchesRepository } from "./GitManager.testkit.ts";

const POLL_INTERVAL_SECONDS = 30;
const POLLS = 61;
const LOOKUP_FAILED = "PR lookup failed; keeping last known PR state.";

const failChangeRequestLookup: SourceControlProvider["Service"]["listChangeRequests"] = (input) =>
  Effect.fail(
    new SourceControlProviderError({
      provider: SourceControlProviderKind.make("github"),
      operation: "listChangeRequests",
      cwd: input.cwd,
      detail: "Injected lookup failure",
    }),
  );

/** How many lookups the failure backoff allows across `polls` polls `interval` seconds apart. */
function attemptsAllowedByBackoff(polls: number, intervalSeconds: number): number {
  let attempts = 0;
  let nextAttemptAt = 0;
  for (let poll = 0; poll < polls; poll += 1) {
    const at = poll * intervalSeconds;
    if (at < nextAttemptAt) continue;
    attempts += 1;
    nextAttemptAt = at + Duration.toSeconds(prLookupFailureTtl(attempts));
  }
  return attempts;
}

describe("PR lookup warning cadence", () => {
  it.effect("retries a cached branch lookup failure only when explicitly requested", () =>
    Effect.gen(function* () {
      const repo = yield* makeTrackedBranchesRepository({
        remoteUrl: "https://github.com/acme/widgets.git",
        branches: ["feature/retry"],
      });
      let attempts = 0;
      const { manager } = yield* makeGitManagerOverRealGit({
        listChangeRequests: (input) =>
          Effect.suspend(() => {
            attempts += 1;
            return failChangeRequestLookup(input);
          }),
      });
      const input = { cwd: repo, branch: "feature/retry" };
      const first = yield* manager.branchPullRequest(input).pipe(Effect.flip);
      expect(first._tag).toBe("SourceControlProviderError");
      expect(attempts).toBe(1);

      const refreshed = yield* manager
        .branchPullRequest(input, { refresh: true })
        .pipe(Effect.flip);
      expect(refreshed).toBe(first);
      expect(attempts).toBe(1);

      const retried = yield* manager
        .branchPullRequest(input, { retryFailedLookup: true })
        .pipe(Effect.flip);
      expect(retried._tag).toBe("SourceControlProviderError");
      expect(attempts).toBe(2);
    }),
  );

  it.effect(
    "PR lookup warning: a failed provider lookup warns once per failure backoff step, not on every 30-second poll",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* makeTrackedBranchesRepository({
            remoteUrl: "https://github.com/acme/widgets.git",
            branches: ["feature/polled"],
            checkout: "feature/polled",
          });
          const { manager } = yield* makeGitManagerOverRealGit({
            listChangeRequests: failChangeRequestLookup,
          });
          const warnings: Array<string> = [];
          const logger = Logger.make<unknown, void>(({ message }) => {
            const text = (Array.isArray(message) ? message : [message]).map(String).join(" ");
            if (text.includes(LOOKUP_FAILED)) warnings.push(text);
          });

          for (let poll = 0; poll < POLLS; poll += 1) {
            // What the poller's refresh reads, without the upstream fetch.
            const remote = yield* manager
              .remoteStatus({ cwd: repo }, { refreshUpstream: false })
              .pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
            expect(remote?.pr ?? null).toBeNull();
            yield* TestClock.adjust(Duration.seconds(POLL_INTERVAL_SECONDS));
          }

          expect(warnings.length).toBeGreaterThanOrEqual(1);
          expect(warnings.length).toBeLessThanOrEqual(
            attemptsAllowedByBackoff(POLLS, POLL_INTERVAL_SECONDS),
          );
        }),
      ),
  );
});
