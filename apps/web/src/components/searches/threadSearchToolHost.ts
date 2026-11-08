/**
 * Mesura: this tab as the search client of one environment
 * (docs/mesura/adr-010-search-chats.md). The server's thread search broker
 * forwards a search conversation's `find_threads` call to one connection; the
 * client searches the environments it holds credentials for and responds.
 */
import type {
  ThreadId,
  ThreadSearchToolEvent,
  ThreadSearchToolResponse,
  ThreadSearchToolResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

export interface ThreadSearchToolRequest {
  readonly threadId: ThreadId;
  readonly description: string;
}

/**
 * Answers the requests `events` carries until it ends. Only requests addressed
 * to this stream's own connection are answered, each request id once, and a
 * cancelled request is interrupted before it can respond.
 */
export const serveThreadSearchToolEvents = Effect.fn("ThreadSearchToolHost.serve")(function* <
  EventError,
  AnswerError,
  RespondError,
  R,
>(
  events: Stream.Stream<ThreadSearchToolEvent, EventError, R>,
  edges: {
    readonly answer: (
      request: ThreadSearchToolRequest,
    ) => Effect.Effect<ThreadSearchToolResult, AnswerError, R>;
    readonly respond: (response: ThreadSearchToolResponse) => Effect.Effect<void, RespondError, R>;
  },
) {
  let connectionId: string | null = null;
  const seen = new Set<string>();
  const tasks = new Map<string, Fiber.Fiber<void>>();
  yield* Effect.scoped(
    Stream.runForEach(events, (event) => {
      switch (event.type) {
        case "connected":
          connectionId = event.connectionId;
          return Effect.void;
        case "cancelled": {
          const task = tasks.get(event.requestId);
          tasks.delete(event.requestId);
          return task ? Fiber.interrupt(task) : Effect.void;
        }
        case "request": {
          // The broker addresses one connection; anything else belongs to another tab.
          if (event.connectionId !== connectionId || seen.has(event.requestId)) return Effect.void;
          seen.add(event.requestId);
          return edges.answer({ threadId: event.threadId, description: event.description }).pipe(
            Effect.flatMap((result) =>
              edges.respond({
                connectionId: event.connectionId,
                requestId: event.requestId,
                result,
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("Thread search tool request could not complete.", cause),
            ),
            Effect.ensuring(Effect.sync(() => tasks.delete(event.requestId))),
            Effect.forkScoped,
            Effect.map((task) => {
              tasks.set(event.requestId, task);
            }),
          );
        }
      }
    }),
  );
});
