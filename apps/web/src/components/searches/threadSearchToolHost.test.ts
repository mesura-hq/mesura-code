/**
 * Phase 3 of the search unification cycle, carried over from phase 2's
 * Implement decision: the web client connects as the search client and
 * answers the `find_threads` requests the server's thread search broker
 * forwards (docs/mesura/adr-010-search-chats.md). The unmerged branch's
 * `ThreadSearchToolRuntime.tsx` held this loop inside a React mount; this
 * spec pins it as a service over the event stream the connection yields
 * (`threadSearchToolConnect`), with the two transport edges injected:
 * `answer` (in the app, `answerThreadSearchToolRequest` over the registered
 * environments) and `respond` (in the app, the `threadSearchToolRespond` RPC).
 *
 * - A connected client answers a request for its connection exactly once.
 * - A request that names another connection (a second tab) is not answered.
 * - A request id delivered twice is answered once.
 * - A cancelled request is interrupted and never answered.
 */
import type {
  ThreadSearchToolEvent,
  ThreadSearchToolResponse,
  ThreadSearchToolResult,
} from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";

import { serveThreadSearchToolEvents } from "./threadSearchToolHost";

const SEARCH_THREAD_ID = ThreadId.make("tool-host-search-thread");

const result: ThreadSearchToolResult = {
  status: "no-match",
  matches: [],
  coverage: { unavailableEnvironments: [], budgetExhausted: false, unreadEvidence: false },
  detail: "No confident match in the reviewed evidence.",
  engine: "text-model",
};

function request(connectionId: string, requestId: string): ThreadSearchToolEvent {
  return {
    type: "request",
    connectionId,
    requestId,
    threadId: SEARCH_THREAD_ID,
    description: "the thread where we renamed the sidebar",
  };
}

/**
 * Serves `events` until the host has responded `responses` times, then ends
 * the stream and waits for the host to finish. Returns what the host answered
 * and responded.
 */
const runHost = Effect.fn(function* (options: {
  readonly events: ReadonlyArray<ThreadSearchToolEvent>;
  readonly responses: number;
}) {
  const queue = yield* Queue.unbounded<ThreadSearchToolEvent, Cause.Done>();
  const answered: Array<{ readonly description: string }> = [];
  const responded: Array<ThreadSearchToolResponse> = [];
  const enoughResponses = yield* Deferred.make<void>();
  const host = yield* serveThreadSearchToolEvents(Stream.fromQueue(queue), {
    answer: (input: { readonly description: string }) =>
      Effect.sync(() => {
        answered.push({ description: input.description });
        return result;
      }),
    respond: (response: ThreadSearchToolResponse) =>
      Effect.sync(() => responded.push(response)).pipe(
        Effect.andThen((count) =>
          count >= options.responses ? Deferred.succeed(enoughResponses, undefined) : Effect.void,
        ),
      ),
  }).pipe(Effect.forkChild);
  for (const event of options.events) yield* Queue.offer(queue, event);
  yield* Deferred.await(enoughResponses);
  yield* Queue.end(queue);
  yield* Fiber.join(host);
  return { answered, responded };
});

describe("thread search tool host", () => {
  it.effect(
    "thread search tool host spec: a connected client answers a request for its connection exactly once",
    () =>
      Effect.gen(function* () {
        const { answered, responded } = yield* runHost({
          events: [{ type: "connected", connectionId: "tab-a" }, request("tab-a", "request-1")],
          responses: 1,
        });
        expect(answered).toEqual([{ description: "the thread where we renamed the sidebar" }]);
        expect(responded).toEqual([{ connectionId: "tab-a", requestId: "request-1", result }]);
      }),
  );

  it.effect(
    "thread search tool host spec: a request naming another tab's connection is not answered",
    () =>
      Effect.gen(function* () {
        const { answered, responded } = yield* runHost({
          events: [
            { type: "connected", connectionId: "tab-a" },
            request("tab-b", "request-for-b"),
            request("tab-a", "request-for-a"),
          ],
          responses: 1,
        });
        expect(answered).toHaveLength(1);
        expect(responded.map((response) => response.requestId)).toEqual(["request-for-a"]);
      }),
  );

  it.effect("thread search tool host spec: a request id delivered twice is answered once", () =>
    Effect.gen(function* () {
      const { responded } = yield* runHost({
        events: [
          { type: "connected", connectionId: "tab-a" },
          request("tab-a", "request-1"),
          request("tab-a", "request-1"),
          request("tab-a", "request-2"),
        ],
        // request-2 follows the duplicate, so its answer shows the duplicate was handled.
        responses: 2,
      });
      expect(responded.map((response) => response.requestId)).toEqual(["request-1", "request-2"]);
    }),
  );

  it.effect(
    "thread search tool host spec: a cancelled request is interrupted and never answered",
    () =>
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<ThreadSearchToolEvent, Cause.Done>();
        const started = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const responded: Array<ThreadSearchToolResponse> = [];
        const host = yield* serveThreadSearchToolEvents(Stream.fromQueue(queue), {
          answer: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
              Effect.as(result),
            ),
          respond: (response: ThreadSearchToolResponse) =>
            Effect.sync(() => {
              responded.push(response);
            }),
        }).pipe(Effect.forkChild);
        yield* Queue.offer(queue, { type: "connected", connectionId: "tab-a" });
        yield* Queue.offer(queue, request("tab-a", "request-1"));
        yield* Deferred.await(started);
        yield* Queue.offer(queue, {
          type: "cancelled",
          connectionId: "tab-a",
          requestId: "request-1",
        });
        yield* Deferred.await(interrupted);
        yield* Queue.end(queue);
        yield* Fiber.join(host);
        expect(responded).toEqual([]);
      }),
  );
});
