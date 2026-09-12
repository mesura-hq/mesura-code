import { EnvironmentId, ThreadId, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  onRetainedMobileBackgroundScopesChange,
  observeMobileBackgroundActivitySubscription,
  retainMobileBackgroundScope,
  retainedMobileBackgroundScopes,
} from "./background-activity-scopes";

describe("mobile background activity", () => {
  it.effect("retains VCS demand only while the mobile subscription is active", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("mobile-environment");
      const release = yield* observeMobileBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "/workspace" },
      });

      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([
        { type: "vcs-status", cwd: "/workspace" },
      ]);

      yield* release;
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([]);
    }),
  );

  it.effect("keeps delimiter-containing environment and scope values distinct", () =>
    Effect.gen(function* () {
      const firstEnvironmentId = EnvironmentId.make("a");
      const secondEnvironmentId = EnvironmentId.make("a:vcs-status:b");
      const releaseFirst = yield* observeMobileBackgroundActivitySubscription({
        environmentId: firstEnvironmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "b:vcs-status:c" },
      });
      const releaseSecond = yield* observeMobileBackgroundActivitySubscription({
        environmentId: secondEnvironmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "c" },
      });

      expect(retainedMobileBackgroundScopes(firstEnvironmentId)).toEqual([
        { type: "vcs-status", cwd: "b:vcs-status:c" },
      ]);
      expect(retainedMobileBackgroundScopes(secondEnvironmentId)).toEqual([
        { type: "vcs-status", cwd: "c" },
      ]);

      yield* Effect.all([releaseFirst, releaseSecond]);
    }),
  );

  it.effect("returns a release handle when a retained-scope listener throws", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("throwing-listener-environment");
      const removeListener = onRetainedMobileBackgroundScopesChange(() => {
        throw new Error("listener failed");
      });

      const release = yield* observeMobileBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "/workspace" },
      });
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([
        { type: "vcs-status", cwd: "/workspace" },
      ]);

      yield* release;
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([]);
      removeListener();
    }),
  );
});

describe("mobile thread background scope", () => {
  it("retains a thread scope until the returned release runs", () => {
    const environmentId = EnvironmentId.make("mobile-thread-retain");
    const release = retainMobileBackgroundScope(environmentId, {
      type: "thread",
      threadId: ThreadId.make("mobile-thread-one"),
    });

    expect(retainedMobileBackgroundScopes(environmentId)).toEqual([
      { type: "thread", threadId: "mobile-thread-one" },
    ]);

    release();
    expect(retainedMobileBackgroundScopes(environmentId)).toEqual([]);
  });

  it("needs one release per retain of the same thread", () => {
    const environmentId = EnvironmentId.make("mobile-thread-refcount");
    const scope = { type: "thread" as const, threadId: ThreadId.make("mobile-thread-two") };
    const releaseFirst = retainMobileBackgroundScope(environmentId, scope);
    const releaseSecond = retainMobileBackgroundScope(environmentId, scope);

    expect(retainedMobileBackgroundScopes(environmentId)).toEqual([scope]);

    releaseFirst();
    expect(retainedMobileBackgroundScopes(environmentId)).toEqual([scope]);

    releaseSecond();
    expect(retainedMobileBackgroundScopes(environmentId)).toEqual([]);
  });

  it("keeps two threads in the same environment distinct", () => {
    const environmentId = EnvironmentId.make("mobile-two-threads");
    const releaseA = retainMobileBackgroundScope(environmentId, {
      type: "thread",
      threadId: ThreadId.make("mobile-thread-a"),
    });
    const releaseB = retainMobileBackgroundScope(environmentId, {
      type: "thread",
      threadId: ThreadId.make("mobile-thread-b"),
    });

    expect(retainedMobileBackgroundScopes(environmentId)).toHaveLength(2);

    releaseA();
    expect(retainedMobileBackgroundScopes(environmentId)).toEqual([
      { type: "thread", threadId: "mobile-thread-b" },
    ]);

    releaseB();
    expect(retainedMobileBackgroundScopes(environmentId)).toEqual([]);
  });

  it("notifies listeners when a thread scope is retained and released", () => {
    const environmentId = EnvironmentId.make("mobile-thread-notify");
    let notifications = 0;
    const unsubscribe = onRetainedMobileBackgroundScopesChange(() => {
      notifications += 1;
    });

    const release = retainMobileBackgroundScope(environmentId, {
      type: "thread",
      threadId: ThreadId.make("mobile-thread-three"),
    });
    expect(notifications).toBe(1);

    release();
    expect(notifications).toBe(2);

    unsubscribe();
  });
});
