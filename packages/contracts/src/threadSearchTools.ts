/**
 * Mesura: search conversations (docs/mesura/adr-010-search-chats.md). A search
 * is an ordinary thread in one hidden project; its agent calls the read-only
 * `find_threads` MCP tool, which the server forwards to one connected client.
 */
import * as Schema from "effect/Schema";

import { EnvironmentId, ProjectId, ThreadId } from "./baseSchemas.ts";
import { TextGenerationError } from "./git.ts";
import { THREAD_SEARCH_REASON_MAX_LENGTH } from "./threadSearchEvidence.ts";

export const THREAD_SEARCH_PROJECT_ID = ProjectId.make("mesura-thread-search");

export const THREAD_SEARCH_DEFAULT_TITLE = "New search";

export const ThreadSearchToolQuery = Schema.Struct({
  description: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
});
export const ThreadSearchToolMatch = Schema.Struct({
  environmentId: EnvironmentId,
  environmentLabel: Schema.String,
  threadId: ThreadId,
  projectId: ProjectId,
  threadTitle: Schema.String,
  projectTitle: Schema.String,
  archivedAt: Schema.NullOr(Schema.String),
  reason: Schema.String.check(Schema.isMaxLength(THREAD_SEARCH_REASON_MAX_LENGTH)),
  url: Schema.String.check(Schema.isMaxLength(2048)),
});
export type ThreadSearchToolMatch = typeof ThreadSearchToolMatch.Type;
export const ThreadSearchToolEngine = Schema.Literals(["jev", "text-model"]);
export type ThreadSearchToolEngine = typeof ThreadSearchToolEngine.Type;
export const ThreadSearchToolResult = Schema.Struct({
  status: Schema.Literals(["matches", "no-match", "failed"]),
  matches: Schema.Array(ThreadSearchToolMatch).check(Schema.isMaxLength(8)),
  coverage: Schema.Struct({
    unavailableEnvironments: Schema.Array(
      Schema.Struct({ environmentId: EnvironmentId, label: Schema.String }),
    ),
    budgetExhausted: Schema.Boolean,
    unreadEvidence: Schema.Boolean,
  }),
  detail: Schema.String.check(Schema.isMaxLength(1000)),
  /** Which classifier answered: Jev, or the configured text model it falls back to. */
  engine: ThreadSearchToolEngine,
});
export type ThreadSearchToolResult = typeof ThreadSearchToolResult.Type;
export const ThreadSearchToolEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("cancelled"),
    connectionId: Schema.String,
    requestId: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("connected"), connectionId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("request"),
    connectionId: Schema.String,
    requestId: Schema.String,
    threadId: ThreadId,
    ...ThreadSearchToolQuery.fields,
  }),
]);
export type ThreadSearchToolEvent = typeof ThreadSearchToolEvent.Type;
export const ThreadSearchToolResponse = Schema.Struct({
  connectionId: Schema.String,
  requestId: Schema.String,
  result: ThreadSearchToolResult,
});
export type ThreadSearchToolResponse = typeof ThreadSearchToolResponse.Type;
export class ThreadSearchToolError extends Schema.TaggedError<ThreadSearchToolError>()(
  "ThreadSearchToolError",
  { message: Schema.String },
) {}
export const StartThreadSearchChatResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
});

/**
 * A Jev step that could not reach Jev: no OpenRouter key on the server, a
 * network failure, or a 5xx. The client answers this one failure by running
 * the configured text model instead; every other Jev failure is reported.
 * It crosses the wire as a `TextGenerationError`, marked by its operation.
 */
const JEV_UNAVAILABLE_OPERATION = "jevThreadSearchUnavailable";

export const jevUnavailableError = (detail: string) =>
  new TextGenerationError({ operation: JEV_UNAVAILABLE_OPERATION, detail });

const isTextGenerationError = Schema.is(TextGenerationError);

export const isJevUnavailableError = (error: unknown): boolean =>
  isTextGenerationError(error) && error.operation === JEV_UNAVAILABLE_OPERATION;
