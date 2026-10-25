// Mesura: search conversations over the WebSocket (ADR-010), across two
// connections. Entry point: `layerWsRpcMesura`, built once per connection the
// way `ws.ts` builds it, on one server-scope context, and called through
// `RpcTest` clients. Every `RpcTest` client is client 0 on its own server, as
// every WebSocket is on its own RPC protocol.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ProviderInstanceId,
  THREAD_SEARCH_WS_METHODS,
  ThreadId,
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
import { FetchHttpClient } from "effect/http";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "./auth/RpcAuthorization.ts";
import * as ServerConfig from "./config.ts";
import { DictationJobs } from "./dictation/DictationJobs.ts";
import { PushSubscriptions } from "./push/PushSubscriptions.ts";
import * as EditorSessionManager from "./editor/Manager.ts";
import * as FactoryRunTracker from "./factory/FactoryRunTracker.ts";
import * as FactorySnapshotStore from "./factory/FactorySnapshotStore.ts";
import * as FileManagerHost from "./fileManager/FileManagerHost.ts";
import { HostStatsService } from "./hostStats/HostStatsService.ts";
import * as ThreadSearchBroker from "./mcp/ThreadSearchBroker.ts";
import { rpcInstrumentationLayer } from "./observability/RpcInstrumentation.ts";
import * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ThreadSearchEvidence from "./orchestration-v2/ThreadSearchEvidence.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as TextGeneration from "./textGeneration/TextGeneration.ts";
import { AccountLimitsService } from "./usage/AccountLimitsService.ts";
import { VcsProvisioningService } from "./vcs/VcsProvisioningService.ts";
import * as WorkspaceFileWatcher from "./workspace/WorkspaceFileWatcher.ts";
import { layerMesuraServerScope, layerWsRpcMesura } from "./wsMesura.ts";

const NO_MATCH: ThreadSearchToolResult = {
  status: "no-match",
  matches: [],
  coverage: { unavailableEnvironments: [], budgetExhausted: false, unreadEvidence: false },
  detail: "No match.",
  engine: "jev",
};

/** The server-scope services, built once; `projectCreates` counts search-project creations. */
const makeServerScope = Effect.fn("WsMesuraThreadSearchTest.makeServerScope")(function* () {
  const projectCreates = yield* Ref.make(0);
  const unused = Layer.mergeAll(
    Layer.mock(ThreadSearchEvidence.ThreadSearchEvidence)({}),
    Layer.mock(TextGeneration.TextGeneration)({}),
    Layer.mock(EditorSessionManager.EditorSessionManager)({}),
    Layer.mock(WorkspaceFileWatcher.WorkspaceFileWatcher)({}),
    Layer.mock(FileManagerHost.FileManagerHost)({}),
    Layer.mock(FactorySnapshotStore.FactorySnapshotStore)({}),
    Layer.mock(FactoryRunTracker.FactoryRunTracker)({}),
    Layer.mock(DictationJobs)({}),
    Layer.mock(PushSubscriptions)({}),
    Layer.mock(HostStatsService)({}),
    Layer.mock(AccountLimitsService)({}),
    Layer.mock(ReviewService.ReviewService)({}),
    Layer.mock(ProjectStore.ProjectStoreV2)({}),
    Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
    FetchHttpClient.layer,
  );
  const starterDependencies = Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({
      create: () => Ref.update(projectCreates, (count) => count + 1).pipe(Effect.as({} as never)),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      dispatch: () => Effect.succeed({ sequence: 1, storedEvents: [] }),
    }),
    Layer.succeed(VcsProvisioningService, { initRepository: () => Effect.void }),
    ServerSettings.layerTest({
      textGenerationModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4-mini",
      },
    }),
    ServerConfig.layerTest(process.cwd(), { prefix: "ws-mesura-thread-search-" }),
  );
  const context = yield* Layer.build(
    Layer.mergeAll(layerMesuraServerScope, unused).pipe(
      Layer.provideMerge(starterDependencies),
      Layer.provideMerge(NodeServices.layer),
    ),
  );
  return { context, projectCreates };
});

/** One WebSocket: its own handler context and its own RPC protocol. */
const connect = (serverScope: Effect.Success<ReturnType<typeof makeServerScope>>) =>
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
    const serverScope = yield* makeServerScope();
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
      const serverScope = yield* makeServerScope();
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
