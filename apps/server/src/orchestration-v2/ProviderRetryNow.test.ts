import { assert, it } from "@effect/vitest";
import { ProviderSessionId, ProviderThreadId, ProviderTurnId, ThreadId } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRetryNow from "./ProviderRetryNow.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

const threadId = ThreadId.make("retry-now-thread");
const providerThreadId = ProviderThreadId.make("retry-now-provider-thread");
const providerTurnId = ProviderTurnId.make("retry-now-provider-turn");
const providerSessionId = ProviderSessionId.make("retry-now-session");
const input = { threadId, providerThreadId, providerTurnId };

const retryWith = (options: {
  readonly sessionId: ProviderSessionId | null;
  readonly session: Option.Option<Partial<ProviderAdapter.ProviderAdapterV2SessionRuntime>>;
}) =>
  Effect.gen(function* () {
    const service = yield* ProviderRetryNow.ProviderRetryNow;
    return yield* service.retry(input);
  }).pipe(
    Effect.provide(
      ProviderRetryNow.layerFromProjections.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getProviderControlContext: () =>
                Effect.succeed({
                  providerThread: { id: providerThreadId, providerSessionId: options.sessionId },
                  providerTurn: { id: providerTurnId },
                } as unknown as ProjectionStore.ProjectionProviderControlContext),
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              get: (id) => {
                assert.equal(id, providerSessionId);
                return Effect.succeed(
                  options.session as Option.Option<ProviderAdapter.ProviderAdapterV2SessionRuntime>,
                );
              },
            }),
          ),
        ),
      ),
    ),
  );

it.effect("Retry now reaches the live session's pending wait", () =>
  Effect.gen(function* () {
    const calls: Array<unknown> = [];
    const result = yield* retryWith({
      sessionId: providerSessionId,
      session: Option.some({
        retryProviderNow: (request) =>
          Effect.sync(() => {
            calls.push(request.providerTurnId);
            return true;
          }),
      }),
    });
    assert.deepEqual(result, { retried: true });
    assert.deepEqual(calls, [providerTurnId]);
  }),
);

it.effect("Retry now reports no retry without a live session or a session id", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* retryWith({ sessionId: providerSessionId, session: Option.none() }), {
      retried: false,
    });
    assert.deepEqual(yield* retryWith({ sessionId: null, session: Option.none() }), {
      retried: false,
    });
    // A provider without capacity retries has no wait to end.
    assert.deepEqual(yield* retryWith({ sessionId: providerSessionId, session: Option.some({}) }), {
      retried: false,
    });
  }),
);
