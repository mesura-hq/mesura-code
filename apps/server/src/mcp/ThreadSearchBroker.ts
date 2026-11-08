/**
 * Mesura: forwards a search conversation's `find_threads` call to one
 * connected client, which searches the environments it is connected to
 * (docs/mesura/adr-010-search-chats.md). The server does not reach other
 * environments itself: their credentials belong to the client.
 */
import {
  ThreadSearchToolError,
  type ThreadSearchToolEvent,
  type ThreadSearchToolResponse,
  type ThreadSearchToolResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

interface Connection {
  id: string;
  sessionId: string;
  queue: Queue.Queue<ThreadSearchToolEvent>;
}
interface Pending {
  connection: Connection;
  deferred: Deferred.Deferred<ThreadSearchToolResult, ThreadSearchToolError>;
}
export class ThreadSearchBroker extends Context.Service<
  ThreadSearchBroker,
  {
    connect: (sessionId: string) => Effect.Effect<Stream.Stream<ThreadSearchToolEvent>>;
    respond: (
      sessionId: string,
      response: ThreadSearchToolResponse,
    ) => Effect.Effect<void, ThreadSearchToolError>;
    invoke: (
      threadId: ThreadId,
      description: string,
    ) => Effect.Effect<ThreadSearchToolResult, ThreadSearchToolError>;
  }
>()("t3/mcp/ThreadSearchBroker") {}

export const layer = Layer.effect(
  ThreadSearchBroker,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const connections = new Map<string, Connection>();
    const pending = new Map<string, Pending>();
    const disconnected = new ThreadSearchToolError({
      message:
        "The search client disconnected. Open the search chat in a connected client and retry.",
    });
    const connect = Effect.fn("ThreadSearchBroker.connect")(function* (sessionId: string) {
      const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const queue = yield* Queue.unbounded<ThreadSearchToolEvent>();
      const connection = { id, sessionId, queue };
      connections.set(id, connection);
      yield* Queue.offer(queue, { type: "connected", connectionId: id });
      return Stream.fromQueue(queue).pipe(
        Stream.ensuring(
          Effect.gen(function* () {
            connections.delete(id);
            for (const [requestId, entry] of pending) {
              if (entry.connection !== connection) continue;
              pending.delete(requestId);
              yield* Deferred.fail(entry.deferred, disconnected);
            }
            yield* Queue.shutdown(queue);
          }),
        ),
      );
    });
    const respond = Effect.fn("ThreadSearchBroker.respond")(function* (
      sessionId: string,
      response: ThreadSearchToolResponse,
    ) {
      const entry = pending.get(response.requestId);
      // A cancelled or completed request can still receive a late client response.
      if (!entry) return;
      if (
        entry.connection.id !== response.connectionId ||
        entry.connection.sessionId !== sessionId
      ) {
        return yield* new ThreadSearchToolError({
          message: "This connection does not own the search request.",
        });
      }
      yield* Deferred.succeed(entry.deferred, response.result);
    });
    const invoke = Effect.fn("ThreadSearchBroker.invoke")(function* (
      threadId: ThreadId,
      description: string,
    ) {
      const requestId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const deferred = yield* Deferred.make<ThreadSearchToolResult, ThreadSearchToolError>();
      // One client performs the federated reads. Broadcasting would duplicate API
      // charges and let independent browser results race to answer one tool call.
      const connection = [...connections.values()].at(-1);
      if (!connection)
        return yield* new ThreadSearchToolError({
          message: "No connected search client is available. Open Mesura Code and retry.",
        });
      // Reserve the slot without yielding after the limit check.
      if (pending.size >= 4)
        return yield* new ThreadSearchToolError({
          message:
            "Four searches are already running. Wait for a result before starting another search.",
        });
      pending.set(requestId, { connection, deferred });
      return yield* Effect.gen(function* () {
        yield* Queue.offer(connection.queue, {
          type: "request",
          connectionId: connection.id,
          requestId,
          threadId,
          description,
        });
        const answered = yield* Deferred.await(deferred).pipe(Effect.timeoutOption("240 seconds"));
        if (Option.isNone(answered))
          return yield* new ThreadSearchToolError({
            message: "The thread search reached its time limit. Try a shorter description.",
          });
        return answered.value;
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            pending.delete(requestId);
            yield* Queue.offer(connection.queue, {
              type: "cancelled",
              connectionId: connection.id,
              requestId,
            });
          }),
        ),
      );
    });
    return ThreadSearchBroker.of({ connect, respond, invoke });
  }),
);
