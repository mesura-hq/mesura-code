import * as Schema from "effect/Schema";

import { ThreadId, TurnItemId } from "./baseSchemas.ts";

/** Mesura: the operator's answer to a browser takeover card. */
export const BrowserTakeoverAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Literals(["done", "declined"]),
});
export type BrowserTakeoverAnswerInput = typeof BrowserTakeoverAnswerInput.Type;

const BROWSER_TAKEOVER_FAILURE_MESSAGES = {
  load_failed: "Could not load the takeover request.",
  not_found: "This takeover request no longer exists.",
  already_answered: "This takeover request was already answered.",
  agent_stopped: "The agent that asked has stopped.",
  record_failed: "Could not update the takeover request.",
} as const;

export const BrowserTakeoverFailureReason = Schema.Literals(
  Object.keys(BROWSER_TAKEOVER_FAILURE_MESSAGES) as Array<
    keyof typeof BROWSER_TAKEOVER_FAILURE_MESSAGES
  >,
);
export type BrowserTakeoverFailureReason = typeof BrowserTakeoverFailureReason.Type;

export class BrowserTakeoverError extends Schema.TaggedError<BrowserTakeoverError>()(
  "BrowserTakeoverError",
  {
    reason: BrowserTakeoverFailureReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return BROWSER_TAKEOVER_FAILURE_MESSAGES[this.reason];
  }
}
