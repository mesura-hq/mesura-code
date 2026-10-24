/**
 * The "PR lookup failed; keeping last known PR state." warning is written once
 * per lookup attempt, not once per remote status poll. The VCS remote status
 * poller (`VcsStatusBroadcaster`, every 30 seconds by default) reads remote
 * status for the cwd a client watches; a failed lookup is cached with
 * `prLookupFailureTtl`, and every poll inside that window replays it. Entry
 * point: `GitManager.remoteStatus` over real git (`GitManager.testkit.ts`), on
 * a repository whose remote no source control provider serves.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";

import { prLookupFailureTtl } from "./GitManager.ts";
import { makeGitManagerOverRealGit, makeTrackedBranchesRepository } from "./GitManager.testkit.ts";

const POLL_INTERVAL_SECONDS = 30;
const POLLS = 61;
const LOOKUP_FAILED = "PR lookup failed; keeping last known PR state.";

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
  it.effect(
    "PR lookup warning: a remote no provider serves warns once per failure backoff step, not on every 30-second poll",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* makeTrackedBranchesRepository({
            remoteUrl: "https://git.example.invalid/acme/widgets.git",
            branches: ["feature/polled"],
            checkout: "feature/polled",
          });
          const { manager } = yield* makeGitManagerOverRealGit();
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
    { timeout: 120_000 },
  );
});
