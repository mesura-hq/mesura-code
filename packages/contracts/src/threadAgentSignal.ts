import * as Schema from "effect/Schema";

import { IsoDateTime, RunId } from "./baseSchemas.ts";

/**
 * Mesura: what a thread's agent declared about the thread. The two kinds exclude each other, so
 * one field carries both.
 */
export const ThreadAgentSignalKind = Schema.Literals(["needs_input", "ready_to_close"]);
export type ThreadAgentSignalKind = typeof ThreadAgentSignalKind.Type;

/**
 * A one- or two-sentence question, shown in the chat status line and a notification. Every shell
 * update carries it to every client, so it is bounded where it enters: the MCP input, the command
 * and the stored signal all use this schema.
 */
export const THREAD_AGENT_SIGNAL_NOTE_MAX_LENGTH = 500;
export const ThreadAgentSignalNote = Schema.String.check(
  Schema.isMaxLength(THREAD_AGENT_SIGNAL_NOTE_MAX_LENGTH),
);

export const ThreadAgentSignal = Schema.Struct({
  kind: ThreadAgentSignalKind,
  note: Schema.NullOr(ThreadAgentSignalNote),
  /** The run active when the agent signalled; a failed or interrupted run takes back its own `ready_to_close`. */
  runId: Schema.NullOr(RunId),
  // An ISO string rather than a DateTime, so the JSON variants of the thread and shell schemas
  // carry it unchanged.
  setAt: IsoDateTime,
});
export type ThreadAgentSignal = typeof ThreadAgentSignal.Type;
