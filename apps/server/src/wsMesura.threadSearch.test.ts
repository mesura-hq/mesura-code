// Mesura: search conversations over the WebSocket (ADR-010), across two
// connections. Entry point: `layerWsRpcMesura`, built once per connection the
// way `ws.ts` builds it, on one server-scope context, and called through
// `RpcTest` clients. Every `RpcTest` client is client 0 on its own server, as
// every WebSocket is on its own RPC protocol.
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ThreadId,
  THREAD_SEARCH_WS_METHODS,
  type ThreadSearchToolEvent,
  type ThreadSearchToolResult,
  WsRpcGroupMesura,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "./auth/RpcAuthorization.ts";
import * as ThreadSearchBroker from "./mcp/ThreadSearchBroker.ts";
import { rpcInstrumentationLayer } from "./observability/RpcInstrumentation.ts";
import { layerWsRpcMesura } from "./wsMesura.ts";
import { makeMesuraServerScope, type MesuraServerScope } from "./wsMesura.testkit.ts";

const NO_MATCH: ThreadSearchToolResult = {
  status: "no-match",
  matches: [],
  coverage: { unavailableEnvironments: [], budgetExhausted: false, unreadEvidence: false },
  detail: "No match.",
  engine: "jev",
};

/** One WebSocket: its own handler context and its own RPC protocol. */
const connect = (serverScope: MesuraServerScope) =>
  Effect.gen(function* () {
    const handlers = yield* Layer.build(
      layerWsRpcMesura.pipe(Layer.provide(Layer.succeedContext(serverScope.context))),
    );
    return yield* RpcTest.makeClient(WsRpcGroupMesura).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeedContext(handlers),
          RpcAuthorization.layer([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]),
          rpcInstrumentationLayer,
        ),
      ),
    );
  });

it.effect("ws search chat spec: two connections starting at once share one search workspace", () =>
  Effect.gen(function* () {
    const serverScope = yield* makeMesuraServerScope();
    const first = yield* connect(serverScope);
    const second = yield* connect(serverScope);

    const [a, b] = yield* Effect.all(
      [
        first[THREAD_SEARCH_WS_METHODS.startThreadSearchChat]({}),
        second[THREAD_SEARCH_WS_METHODS.startThreadSearchChat]({}),
      ],
      { concurrency: 2 },
    );

    assert.notEqual(a.threadId, b.threadId);
    // One server-scope starter prepares the workspace and project once; a
    // starter per connection would prepare them once per connection.
    assert.equal(yield* Ref.get(serverScope.projectCreates), 1);
  }).pipe(Effect.scoped),
);

it.effect(
  "ws search chat spec: another connection cannot answer a find_threads request it was not sent",
  () =>
    Effect.gen(function* () {
      const serverScope = yield* makeMesuraServerScope();
      const owner = yield* connect(serverScope);
      const other = yield* connect(serverScope);
      const received = yield* Deferred.make<Extract<ThreadSearchToolEvent, { type: "request" }>>();
      yield* owner[THREAD_SEARCH_WS_METHODS.threadSearchToolConnect]({}).pipe(
        Stream.runForEach((event) =>
          event.type === "request" ? Deferred.succeed(received, event) : Effect.void,
        ),
        Effect.forkScoped,
      );
      const broker = yield* ThreadSearchBroker.ThreadSearchBroker.pipe(
        Effect.provide(Layer.succeedContext(serverScope.context)),
      );
      const caller = yield* broker
        .invoke(ThreadId.make("thread-search-owner"), "the cache clock bug")
        .pipe(Effect.forkScoped);
      const request = yield* Deferred.await(received);
      const response = {
        connectionId: request.connectionId,
        requestId: request.requestId,
        result: NO_MATCH,
      };

      const forged = yield* other[THREAD_SEARCH_WS_METHODS.threadSearchToolRespond](response).pipe(
        Effect.flip,
      );
      assert.equal(forged._tag, "ThreadSearchToolError");
      assert.isUndefined(caller.pollUnsafe());

      yield* owner[THREAD_SEARCH_WS_METHODS.threadSearchToolRespond](response);
      assert.deepEqual(yield* Fiber.join(caller), NO_MATCH);
    }).pipe(Effect.scoped),
);
