/**
 * Mesura: "Retry now" on a provider retry row. The wait lives in the provider
 * adapter's process, so this reaches the live session instead of recording a
 * command: a server restart already ends every wait.
 */
import {
  ProviderRetryNowError,
  type ProviderRetryNowInput,
  type ProviderRetryNowResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

export class ProviderRetryNow extends Context.Service<
  ProviderRetryNow,
  {
    readonly retry: (
      input: ProviderRetryNowInput,
    ) => Effect.Effect<ProviderRetryNowResult, ProviderRetryNowError>;
  }
>()("t3/orchestration-v2/ProviderRetryNow") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

  const retry = Effect.fn("ProviderRetryNow.retry")(function* (
    input: ProviderRetryNowInput,
  ): Effect.fn.Return<ProviderRetryNowResult, ProviderRetryNowError> {
    const { providerThread, providerTurn } = yield* projections
      .getProviderControlContext(input.threadId, input)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderRetryNowError({ message: "Could not read the provider turn.", cause }),
        ),
      );
    if (providerThread?.providerSessionId == null || providerTurn === undefined) {
      return { retried: false };
    }
    const session = yield* sessions
      .get(providerThread.providerSessionId)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderRetryNowError({ message: "Could not reach the provider session.", cause }),
        ),
      );
    if (Option.isNone(session) || session.value.retryProviderNow === undefined) {
      return { retried: false };
    }
    const retried = yield* session.value.retryProviderNow({
      providerThread,
      providerTurnId: providerTurn.id,
    });
    return { retried };
  });
  return ProviderRetryNow.of({ retry });
});

/** Takes the projection reader from its caller, as tests do. */
export const layerFromProjections = Layer.effect(ProviderRetryNow, make);

// The projection reader is a thin SQL view; the same pattern as RemoteDelegation in server.ts.
export const layer = layerFromProjections.pipe(Layer.provide(ProjectionStore.layer));
