import * as Schema from "effect/Schema";

import { ProviderThreadId, ProviderTurnId, ThreadId } from "./baseSchemas.ts";

/** Mesura: ends a provider retry wait early, from the retry row's "Retry now". */
export const ProviderRetryNowInput = Schema.Struct({
  threadId: ThreadId,
  providerThreadId: ProviderThreadId,
  providerTurnId: ProviderTurnId,
});
export type ProviderRetryNowInput = typeof ProviderRetryNowInput.Type;

/** `retried` is false when no wait was pending: the retry already started or the turn ended. */
export const ProviderRetryNowResult = Schema.Struct({ retried: Schema.Boolean });
export type ProviderRetryNowResult = typeof ProviderRetryNowResult.Type;

export class ProviderRetryNowError extends Schema.TaggedError<ProviderRetryNowError>()(
  "ProviderRetryNowError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}
