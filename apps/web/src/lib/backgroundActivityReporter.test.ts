import { EnvironmentId, ThreadId, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  observeBackgroundActivitySubscription,
  retainBackgroundScope,
  retainedBackgroundScopes,
  wasRecentlyInteracted,
} from "./backgroundActivityReporter.ts";

describe("wasRecentlyInteracted", () => {
  it("expires interaction independently of window focus", () => {
    expect(wasRecentlyInteracted(10_000, 55_000)).toBe(true);
    expect(wasRecentlyInteracted(10_000, 55_001)).toBe(false);
  });

  it("rejects future timestamps", () => {
    expect(wasRecentlyInteracted(10_001, 10_000)).toBe(false);
  });

  it.effect("retains an observed subscription until its returned finalizer runs", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-observation-test");
      const scope = { type: "vcs-status" as const, cwd: "/repo" };
      const release = yield* observeBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: scope.cwd },
      });

      expect(retainedBackgroundScopes(environmentId)).toEqual([scope]);

      yield* release;
      expect(retainedBackgroundScopes(environmentId)).toEqual([]);
    }),
  );

  it.effect("keeps delimiter-containing environment and scope values distinct", () =>
    Effect.gen(function* () {
      const firstEnvironmentId = EnvironmentId.make("a");
      const secondEnvironmentId = EnvironmentId.make("a:vcs-status:b");
      const releaseFirst = yield* observeBackgroundActivitySubscription({
        environmentId: firstEnvironmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "b:vcs-status:c" },
      });
      const releaseSecond = yield* observeBackgroundActivitySubscription({
        environmentId: secondEnvironmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "c" },
      });

      expect(retainedBackgroundScopes(firstEnvironmentId)).toEqual([
        { type: "vcs-status", cwd: "b:vcs-status:c" },
      ]);
      expect(retainedBackgroundScopes(secondEnvironmentId)).toEqual([
        { type: "vcs-status", cwd: "c" },
      ]);

      yield* Effect.all([releaseFirst, releaseSecond]);
    }),
  );
});

describe("thread background scope", () => {
  it("retains a thread scope until the returned release runs", () => {
    const environmentId = EnvironmentId.make("environment-thread-retain");
    const release = retainBackgroundScope(environmentId, {
      type: "thread",
      threadId: ThreadId.make("thread-one"),
    });

    expect(retainedBackgroundScopes(environmentId)).toEqual([
      { type: "thread", threadId: "thread-one" },
    ]);

    release();
    expect(retainedBackgroundScopes(environmentId)).toEqual([]);
  });

  it("needs one release per retain of the same thread", () => {
    const environmentId = EnvironmentId.make("environment-thread-refcount");
    const scope = { type: "thread" as const, threadId: ThreadId.make("thread-two") };
    const releaseFirst = retainBackgroundScope(environmentId, scope);
    const releaseSecond = retainBackgroundScope(environmentId, scope);

    expect(retainedBackgroundScopes(environmentId)).toEqual([scope]);

    releaseFirst();
    expect(retainedBackgroundScopes(environmentId)).toEqual([scope]);

    releaseSecond();
    expect(retainedBackgroundScopes(environmentId)).toEqual([]);
  });

  it("keeps two threads in the same environment distinct", () => {
    const environmentId = EnvironmentId.make("environment-two-threads");
    const releaseA = retainBackgroundScope(environmentId, {
      type: "thread",
      threadId: ThreadId.make("thread-a"),
    });
    const releaseB = retainBackgroundScope(environmentId, {
      type: "thread",
      threadId: ThreadId.make("thread-b"),
    });

    expect(retainedBackgroundScopes(environmentId)).toHaveLength(2);

    releaseA();
    expect(retainedBackgroundScopes(environmentId)).toEqual([
      { type: "thread", threadId: "thread-b" },
    ]);

    releaseB();
  });
});
