// Entry point: WsRpcGroupMesura through RpcTest and layerWsRpcMesura, then a fresh store
// instance on the same isolated ServerConfig to simulate a server restart.
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  WsRpcGroupMesura,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "./auth/RpcAuthorization.ts";
import * as ClientTimeZone from "./orchestration-v2/ClientTimeZone.ts";
import { rpcInstrumentationLayer } from "./observability/RpcInstrumentation.ts";
import { layerMesuraServerScope, layerWsRpcMesura } from "./wsMesura.ts";
import * as RuntimeLayer from "./orchestration-v2/runtimeLayer.ts";
import * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";
import * as CheckpointStore from "./checkpointing/CheckpointStore.ts";
import * as GitWorkflow from "./git/GitWorkflowService.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import * as McpSessionRegistryTestkit from "./mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ServerConfig from "./config.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import { makeMesuraServerScope } from "./wsMesura.testkit.ts";

it.effect(
  "snooze-zone AC4 spec: fork RPC keeps the last client zone across connections and a server restart",
  () =>
    Effect.gen(function* () {
      expect([...WsRpcGroupMesura.requests.keys()]).toContain("server.reportClientTimeZone");
      const server = yield* makeMesuraServerScope();
      const connect = Effect.fn("SnoozeZoneFence.connect")(function* () {
        return yield* RpcTest.makeClient(WsRpcGroupMesura).pipe(
          Effect.provide(
            Layer.mergeAll(
              layerWsRpcMesura.pipe(Layer.provide(Layer.succeedContext(server.context))),
              RpcAuthorization.layer([
                AuthOrchestrationReadScope,
                AuthOrchestrationOperateScope,
                AuthSettingsWriteScope,
              ]),
              rpcInstrumentationLayer,
            ),
          ),
        );
      });
      const first = yield* connect();
      const second = yield* connect();
      const store = yield* ClientTimeZone.ClientTimeZone.pipe(Effect.provide(server.context));
      expect(yield* store.get).toBeNull();
      yield* first["server.reportClientTimeZone"]({ timeZone: "America/New_York" });
      expect(yield* store.get).toBe("America/New_York");
      yield* second["server.reportClientTimeZone"]({ timeZone: "Asia/Kathmandu" });
      expect(yield* store.get).toBe("Asia/Kathmandu");
      // A fresh layer has no in-memory state from the first store.
      const restarted = yield* ClientTimeZone.ClientTimeZone.pipe(
        Effect.provide(
          Layer.fresh(ClientTimeZone.layer).pipe(
            Layer.provide(Layer.succeedContext(server.context)),
          ),
        ),
      );
      expect(yield* restarted.get).toBe("Asia/Kathmandu");
    }).pipe(Effect.scoped),
);

it.effect("snooze-zone rework P3-5: read-only RPC cannot change the device zone", () =>
  Effect.gen(function* () {
    const server = yield* makeMesuraServerScope();
    const store = yield* ClientTimeZone.ClientTimeZone.pipe(Effect.provide(server.context));
    const client = yield* RpcTest.makeClient(WsRpcGroupMesura).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerWsRpcMesura.pipe(Layer.provide(Layer.succeedContext(server.context))),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
          rpcInstrumentationLayer,
        ),
      ),
    );
    const error = yield* client["server.reportClientTimeZone"]({ timeZone: "Asia/Tokyo" }).pipe(
      Effect.flip,
    );
    expect(error).toMatchObject({
      _tag: "EnvironmentAuthorizationError",
      requiredPermission: AuthOrchestrationOperateScope,
    });
    expect(yield* store.get).toBeNull();
  }).pipe(Effect.scoped),
);

// Build the actual runtime layer beside the actual fork server scope, as server.ts does.
// Only unrelated provider, Git, and checkpoint capabilities use test doubles.
it.effect("snooze-zone closure P2-1: production runtime reads the persisted RPC store", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-03-07T12:00:00Z"));
    const server = yield* makeMesuraServerScope();
    const context = yield* Layer.build(
      layerMesuraServerScope.pipe(
        Layer.provideMerge(RuntimeLayer.layer),
        Layer.provide(McpSessionRegistryTestkit.layer),
        Layer.provide(McpProviderSessions.layer),
        Layer.provide(SqlitePersistence.layerMemory),
        Layer.provide(Layer.mock(CheckpointStore.CheckpointStore)({})),
        Layer.provide(Layer.mock(GitWorkflow.GitWorkflowService)({})),
        Layer.provide(
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolveLink: () => Effect.die("source control is unused by snooze"),
          }),
        ),
        Layer.provide(
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            getInstance: () => Effect.die("providers are unused by snooze"),
            listInstances: Effect.succeed([]),
            listUnavailable: Effect.succeed([]),
          }),
        ),
        // Exclude the helper's store: only the production layers may supply it here.
        Layer.provide(
          Layer.succeedContext(server.context.pipe(Context.omit(ClientTimeZone.ClientTimeZone))),
        ),
      ),
    );
    const client = yield* RpcTest.makeClient(WsRpcGroupMesura).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerWsRpcMesura.pipe(
            Layer.provide(Layer.succeedContext(Context.merge(server.context, context))),
          ),
          RpcAuthorization.layer([AuthOrchestrationOperateScope]),
          rpcInstrumentationLayer,
        ),
      ),
    );
    const threads = Context.get(context, ThreadManagementService.ThreadManagementService);
    const threadId = ThreadId.make("snooze-zone-production-wiring");
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make("snooze-zone-production-create"),
      threadId,
      projectId: ProjectId.make("snooze-zone-production-project"),
      title: "Production zone wiring",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "user",
      creationSource: "web",
      branch: null,
      worktreePath: null,
    });
    // Report after constructing the runtime: loading the file once cannot satisfy this.
    yield* client["server.reportClientTimeZone"]({ timeZone: "Asia/Kathmandu" });
    const result = yield* threads.snoozeThread({
      commandId: CommandId.make("snooze-zone-production-snooze"),
      threadId,
      snoozeUntilLocal: "2026-03-08T09:00",
    });
    expect(result).toMatchObject({
      snoozedUntil: "2026-03-08T03:15:00.000Z",
      snoozedUntilLocal: "2026-03-08T09:00",
      timeZone: "Asia/Kathmandu",
      timeZoneSource: "device",
    });
    const config = Context.get(server.context, ServerConfig.ServerConfig);
    const fs = yield* FileSystem.FileSystem.pipe(Effect.provide(server.context));
    expect(JSON.parse(yield* fs.readFileString(config.stateDir + "/client-time-zone.json"))).toBe(
      "Asia/Kathmandu",
    );
  }).pipe(Effect.scoped),
);
