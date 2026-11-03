import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ThreadId, type OrchestrationV2ServerCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema } from "effect/ai";
import type { McpServer } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import * as ClientTimeZone from "../../../orchestration-v2/ClientTimeZone.ts";
import { makeSnoozeThread } from "../../../orchestration-v2/threadSnooze.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderSessionManager from "../../../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";

export const TARGET = ThreadId.make("thread:snooze-zone-target");

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "snooze-zone-fence", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "snooze-zone-fence", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

export const makeOrganizeServer = Effect.fn("SnoozeZoneFence.makeOrganizeServer")(function* <
  R = never,
>(
  mcp: typeof McpServer,
  settings: Parameters<typeof ServerSettings.layerTest>[0] = {},
  additionalDependencies?: Layer.Layer<R>,
) {
  const commands: Array<OrchestrationV2ServerCommand> = [];
  const settles: Array<{ threadId: ThreadId; byOwnAgent: boolean }> = [];
  const shell = liveThreadShell(TARGET);
  const dispatch = (command: OrchestrationV2ServerCommand) =>
    Effect.sync(() => {
      commands.push(command);
      return { sequence: 17, storedEvents: [] };
    });
  const baseDependencies = Layer.mergeAll(
    NodeServices.layer,
    ClientTimeZone.layer.pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "snooze-organize-" })),
      Layer.provide(NodeServices.layer),
    ),
    ServerSettings.layerTest(settings),
    Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
    Layer.mock(ThreadSearch.ThreadSearch)({}),
    Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
  );
  const dependencies = additionalDependencies
    ? Layer.merge(baseDependencies, additionalDependencies)
    : baseDependencies;
  const threadService = Layer.unwrap(
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const clientTimeZone = yield* ClientTimeZone.ClientTimeZone;
      return Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(shell),
        getProjectThreadRecords: () => Effect.succeed(idleThreadProjection(shell)),
        dispatch,
        snoozeThread: makeSnoozeThread(dispatch, { serverSettings, clientTimeZone }),
        settleThread: (input) =>
          Effect.sync(() => {
            settles.push(input);
            return { settlesWhenTurnEnds: true as const };
          }),
      });
    }),
  ).pipe(Layer.provide(dependencies));
  const registration = McpHttpServer.layerThreadToolkit.pipe(
    Layer.provideMerge(mcp.McpServer.layer),
    Layer.provide(Layer.merge(dependencies, threadService)),
  );
  const server = yield* mcp.McpServer.pipe(Effect.provide(registration));
  const call = (args: Readonly<Record<string, unknown>>) =>
    server.callTool({ name: "t3_thread_organize", arguments: args }).pipe(
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment:snooze-zone"),
        requestNamespace: "snooze-zone-fence",
        thread: undefined,
        client: { sessionId: "snooze-zone-fence", label: "Fence", access: "full-access" },
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
    );
  return { server, call, commands, settles };
});
