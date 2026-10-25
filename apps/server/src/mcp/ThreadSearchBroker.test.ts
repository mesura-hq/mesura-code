// Mesura: the broker that forwards a `find_threads` call to one connected
// client (ADR-010). Entry point: `ThreadSearchBroker.layer`, driven through
// `connect`, `invoke` and `respond` as the WebSocket handlers and the MCP tool
// call them. Ported from commit d4e841fb56; every title carries "thread search
// broker" so a name-filtered re-run matches it exactly.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ThreadId,
  type ThreadSearchToolEvent,
  type ThreadSearchToolResult,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ThreadSearchBroker, layer } from "./ThreadSearchBroker.ts";

const threadId = ThreadId.make("search-chat");
const result: ThreadSearchToolResult = {
  status: "no-match",
  matches: [],
  coverage: { unavailableEnvironments: [], budgetExhausted: false, unreadEvidence: false },
  detail: "No match.",
  engine: "jev",
};
const provideBroker = <A, E>(effect: Effect.Effect<A, E, ThreadSearchBroker>) =>
  effect.pipe(Effect.provide(layer.pipe(Layer.provide(NodeServices.layer))));

it.effect(
  "thread search broker routes one request to the newest client and accepts only its response",
  () =>
    provideBroker(
      Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* ThreadSearchBroker;
          const older = yield* broker.connect("older-session");
          const olderEvents: ThreadSearchToolEvent[] = [];
          yield* Stream.runForEach(older, (event) =>
            Effect.sync(() => olderEvents.push(event)),
          ).pipe(Effect.forkScoped);
          const newest = yield* broker.connect("newest-session");
          const received =
            yield* Deferred.make<Extract<ThreadSearchToolEvent, { type: "request" }>>();
          yield* Stream.runForEach(newest, (event) =>
            event.type === "request" ? Deferred.succeed(received, event) : Effect.void,
          ).pipe(Effect.forkScoped);
          const caller = yield* broker
            .invoke(threadId, "rework of model picker")
            .pipe(Effect.forkScoped);
          const request = yield* Deferred.await(received);
          expect(request.description).toBe("rework of model picker");
          expect(request.threadId).toBe(threadId);
          const response = {
            connectionId: request.connectionId,
            requestId: request.requestId,
            result,
          };
          const rejected = yield* Effect.result(broker.respond("older-session", response));
          expect(Result.isFailure(rejected)).toBe(true);
          yield* broker.respond("newest-session", response);
          expect(yield* Fiber.join(caller)).toEqual(result);
          expect(olderEvents.some((event) => event.type === "request")).toBe(false);
        }),
      ),
    ),
);

it.effect(
  "thread search broker fails a pending find_threads call when its client disconnects",
  () =>
    provideBroker(
      Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* ThreadSearchBroker;
          const events = yield* broker.connect("session");
          const received = yield* Deferred.make<void>();
          const consumer = yield* Stream.runForEach(events, (event) =>
            event.type === "request" ? Deferred.succeed(received, undefined) : Effect.void,
          ).pipe(Effect.forkScoped);
          const caller = yield* broker
            .invoke(threadId, "model picker")
            .pipe(Effect.result, Effect.forkScoped);
          yield* Deferred.await(received);
          yield* Fiber.interrupt(consumer);
          const answer = yield* Fiber.join(caller);
          expect(Result.isFailure(answer)).toBe(true);
          if (Result.isFailure(answer)) expect(answer.failure.message).toContain("disconnected");
        }),
      ),
    ),
);

it.effect("thread search broker reports a missing client instead of an invented result", () =>
  provideBroker(
    Effect.gen(function* () {
      const broker = yield* ThreadSearchBroker;
      const answer = yield* Effect.result(broker.invoke(threadId, "model picker"));
      expect(Result.isFailure(answer)).toBe(true);
      if (Result.isFailure(answer))
        expect(answer.failure.message).toContain("No connected search client");
    }),
  ),
);

it.effect("thread search broker ignores a late response after the tool call was cancelled", () =>
  provideBroker(
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* ThreadSearchBroker;
        const events = yield* broker.connect("session");
        const received =
          yield* Deferred.make<Extract<ThreadSearchToolEvent, { type: "request" }>>();
        const cancelled =
          yield* Deferred.make<Extract<ThreadSearchToolEvent, { type: "cancelled" }>>();
        yield* Stream.runForEach(events, (event) =>
          event.type === "request"
            ? Deferred.succeed(received, event)
            : event.type === "cancelled"
              ? Deferred.succeed(cancelled, event)
              : Effect.void,
        ).pipe(Effect.forkScoped);
        const caller = yield* broker.invoke(threadId, "model picker").pipe(Effect.forkScoped);
        const request = yield* Deferred.await(received);
        yield* Fiber.interrupt(caller);
        expect((yield* Deferred.await(cancelled)).requestId).toBe(request.requestId);
        yield* broker.respond("session", {
          connectionId: request.connectionId,
          requestId: request.requestId,
          result,
        });
      }),
    ),
  ),
);

it.effect("thread search broker limits concurrent invocations to four pending searches", () =>
  provideBroker(
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* ThreadSearchBroker;
        const events = yield* broker.connect("session");
        const requests: Extract<ThreadSearchToolEvent, { type: "request" }>[] = [];
        const receivedFour = yield* Deferred.make<void>();
        const rejectedFour = yield* Deferred.make<void>();
        let rejectedCount = 0;
        yield* Stream.runForEach(events, (event) =>
          Effect.gen(function* () {
            if (event.type !== "request") return;
            requests.push(event);
            if (requests.length === 4) yield* Deferred.succeed(receivedFour, undefined);
          }),
        ).pipe(Effect.forkScoped);
        const callers = yield* Effect.forEach(
          Array.from({ length: 8 }, (_, index) => index),
          (index) =>
            broker.invoke(threadId, `search ${index}`).pipe(
              Effect.result,
              Effect.tap((answer) =>
                Effect.gen(function* () {
                  if (!Result.isFailure(answer)) return;
                  expect(answer.failure.message).toContain("Four searches");
                  rejectedCount += 1;
                  if (rejectedCount === 4) yield* Deferred.succeed(rejectedFour, undefined);
                }),
              ),
            ),
          { concurrency: "unbounded" },
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(receivedFour);
        yield* Deferred.await(rejectedFour);
        expect(requests).toHaveLength(4);
        for (const request of requests) {
          yield* broker.respond("session", { ...request, result });
        }
        const answers = yield* Fiber.join(callers);
        expect(answers.filter(Result.isSuccess)).toHaveLength(4);
        expect(answers.filter(Result.isFailure)).toHaveLength(4);
      }),
    ),
  ),
);

it.effect("thread search broker times out an unanswered request and cancels client work", () =>
  provideBroker(
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* ThreadSearchBroker;
        const events = yield* broker.connect("session");
        const received =
          yield* Deferred.make<Extract<ThreadSearchToolEvent, { type: "request" }>>();
        const cancelled =
          yield* Deferred.make<Extract<ThreadSearchToolEvent, { type: "cancelled" }>>();
        yield* Stream.runForEach(events, (event) =>
          event.type === "request"
            ? Deferred.succeed(received, event)
            : event.type === "cancelled"
              ? Deferred.succeed(cancelled, event)
              : Effect.void,
        ).pipe(Effect.forkScoped);
        const caller = yield* broker
          .invoke(threadId, "model picker")
          .pipe(Effect.result, Effect.forkScoped);
        const request = yield* Deferred.await(received);
        yield* TestClock.adjust("240 seconds");
        const answer = yield* Fiber.join(caller);
        expect(Result.isFailure(answer)).toBe(true);
        if (Result.isFailure(answer)) expect(answer.failure.message).toContain("time limit");
        expect((yield* Deferred.await(cancelled)).requestId).toBe(request.requestId);
      }),
    ),
  ),
);
