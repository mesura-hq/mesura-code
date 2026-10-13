import type * as ProviderRuntimeResources from "../agentResources/ProviderRuntimeResources.ts";
// Entry point: production ws.layer GET /ws and its real scoped RpcServer.
// Authentication, session state, authorization, private registry and SQL are real.
// The socket/manager are external ports. Cancellation cases retain a real
// scoped child without invoking a host manager. Direct bridge behavior is separate.
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthDiagnosticsReadScope,
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Socket from "effect/socket/Socket";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Ws from "../ws.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as WorkloadHost from "./WorkloadHost.ts";
import * as WorkloadHostBridge from "./WorkloadHostBridge.ts";
import { withControlFixture, withHostBridgeFixture } from "./workloadTestkit.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as McpAppRequests from "../mcpApps/McpAppRequests.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as PullRequestSyncReactor from "../orchestration-v2/PullRequestSyncReactor.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as AgentSessionScanner from "../project/AgentSessionScanner.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as Keybindings from "../keybindings.ts";
import * as EnvironmentTheme from "../environmentTheme.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as RemoteOpenTargets from "../environment/RemoteOpenTargets.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ReviewService from "../review/ReviewService.ts";
import * as VcsProvisioningService from "../vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as ProviderMaintenanceRunner from "../provider/providerMaintenanceRunner.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as SourceControlDiscovery from "../sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as ProcessDiagnostics from "../diagnostics/ProcessDiagnostics.ts";
import * as TraceDiagnostics from "../diagnostics/TraceDiagnostics.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ProcessResourceMonitor from "../diagnostics/ProcessResourceMonitor.ts";
import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";
import * as FactorySnapshotStore from "../factory/FactorySnapshotStore.ts";
import * as ThreadSearchEvidence from "../orchestration-v2/ThreadSearchEvidence.ts";
import * as EditorSessionManager from "../editor/Manager.ts";
import * as WorkspaceFileWatcher from "../workspace/WorkspaceFileWatcher.ts";
import * as FileManagerHost from "../fileManager/FileManagerHost.ts";
import * as FactoryRunTracker from "../factory/FactoryRunTracker.ts";
import { DictationJobs } from "../dictation/DictationJobs.ts";
import { HostStatsService } from "../hostStats/HostStatsService.ts";
import { ProjectIconDiscovery } from "../project/ProjectIconDiscovery.ts";
import { AccountLimitsService } from "../usage/AccountLimitsService.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import * as AntigravityInstallation from "../provider/AntigravityInstallation.ts";
vi.mock("node:fs/promises", async () => {
  const { fixtureFileSystem } = await import("./workloadTestkit.ts");
  return fixtureFileSystem();
});
vi.mock("../project/AgentSessionScanner.ts", async () => {
  const actual = await vi.importActual<typeof import("../project/AgentSessionScanner.ts")>(
    "../project/AgentSessionScanner.ts",
  );
  return { ...actual, layer: Layer.mock(actual.AgentSessionScanner)({}) };
});
vi.mock("../provider/providerMaintenanceRunner.ts", async () => {
  const actual = await vi.importActual<typeof import("../provider/providerMaintenanceRunner.ts")>(
    "../provider/providerMaintenanceRunner.ts",
  );
  return { ...actual, layer: Layer.mock(actual.ProviderMaintenanceRunner)({}) };
});
vi.mock("../sourceControl/SourceControlDiscovery.ts", async () => {
  const actual = await vi.importActual<typeof import("../sourceControl/SourceControlDiscovery.ts")>(
    "../sourceControl/SourceControlDiscovery.ts",
  );
  return { ...actual, layer: Layer.mock(actual.SourceControlDiscovery)({}) };
});
vi.mock("../sourceControl/SourceControlProviderRegistry.ts", async () => {
  const actual = await vi.importActual<
    typeof import("../sourceControl/SourceControlProviderRegistry.ts")
  >("../sourceControl/SourceControlProviderRegistry.ts");
  return {
    ...actual,
    layer: Layer.mock(actual.SourceControlProviderRegistry)({ resolveLink: () => undefined }),
  };
});
vi.mock("../vcs/VcsDriverRegistry.ts", async () => {
  const actual = await vi.importActual<typeof import("../vcs/VcsDriverRegistry.ts")>(
    "../vcs/VcsDriverRegistry.ts",
  );
  return { ...actual, layer: Layer.mock(actual.VcsDriverRegistry)({}) };
});
vi.mock("../vcs/VcsProjectConfig.ts", async () => {
  const actual = await vi.importActual<typeof import("../vcs/VcsProjectConfig.ts")>(
    "../vcs/VcsProjectConfig.ts",
  );
  return { ...actual, layer: Layer.mock(actual.VcsProjectConfig)({}) };
});
vi.mock("../sourceControl/builtInDrivers.ts", () => ({ layer: Layer.empty }));
vi.mock("../vcs/GitVcsDriver.ts", async () => {
  const actual =
    await vi.importActual<typeof import("../vcs/GitVcsDriver.ts")>("../vcs/GitVcsDriver.ts");
  return { ...actual, layer: Layer.empty };
});
const unrelatedPorts = Layer.mergeAll(
  Layer.mock(ServerEnvironment.ServerEnvironment)({}),
  Layer.mock(TextGeneration.TextGeneration)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
  Layer.mock(ProjectStore.ProjectStoreV2)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({}),
  Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
    namedProjectsRoot: "/unused-projects",
  }),
  Layer.mock(ThreadSearch.ThreadSearch)({}),
  Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
  Layer.mock(McpAppRequests.McpAppRequests)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(PullRequestService.PullRequestService)({}),
  Layer.mock(PullRequestSyncReactor.PullRequestSyncReactor)({}),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(UsageService.UsageService)({}),
  Layer.mock(UsageLimitSources.UsageLimitSources)({}),
  Layer.mock(WorktreeSetupTracker.WorktreeSetupTracker)({}),
  Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
  Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
  Layer.mock(AgentSessionScanner.AgentSessionScanner)({}),
  Layer.mock(AgentSessionImporter.AgentSessionImporter)({}),
  Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({}),
  Layer.mock(Keybindings.Keybindings)({}),
  Layer.mock(EnvironmentTheme.EnvironmentThemeService)({}),
  Layer.mock(ExternalLauncher.ExternalLauncher)({}),
  Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
  Layer.mock(DirectEndpoints.DirectEndpoints)({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(ReviewService.ReviewService)({}),
  Layer.mock(VcsProvisioningService.VcsProvisioningService)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(VcsProcess.VcsProcess)({}),
  Layer.mock(TerminalManager.TerminalManager)({}),
  Layer.mock(PreviewManager.PreviewManager)({}),
  Layer.mock(PortScanner.PortDiscovery)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ModelManifest.ModelManifest)({}),
  Layer.mock(ProviderLatestVersions.ProviderLatestVersions)({}),
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
  Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({}),
  Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({}),
  Layer.mock(ProviderMaintenanceRunner.ProviderMaintenanceRunner)({}),
  Layer.mock(ProviderAuthService.ProviderAuthService)({}),
  Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({}),
  Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({}),
  Layer.mock(PeerLinks.PeerLinks)({}),
  Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
  Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
  Layer.mock(WorkspaceEntries.WorkspaceEntries)({}),
  Layer.mock(WorkspaceFileSystem.WorkspaceFileSystem)({}),
  Layer.mock(WorkspacePaths.WorkspacePaths)({}),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
  Layer.mock(SourceControlDiscovery.SourceControlDiscovery)({}),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(PairingGrantStore.PairingGrantStore)({}),
  Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({}),
  Layer.mock(TraceDiagnostics.TraceDiagnostics)({}),
  Layer.mock(HostResources.HostResources)({}),
  Layer.mock(ProcessResourceMonitor.ProcessResourceMonitor)({}),
  Layer.mock(ResourceTelemetry.ResourceTelemetry)({}),
  Layer.mock(RelayClient.RelayClient)({}),
  Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
  Layer.mock(ServerBrowser.ServerBrowser)({}),
  Layer.mock(FactorySnapshotStore.FactorySnapshotStore)({}),
  Layer.mock(ThreadSearchEvidence.ThreadSearchEvidence)({}),
  Layer.mock(EditorSessionManager.EditorSessionManager)({}),
  Layer.mock(WorkspaceFileWatcher.WorkspaceFileWatcher)({}),
  Layer.mock(FileManagerHost.FileManagerHost)({}),
  Layer.mock(FactoryRunTracker.FactoryRunTracker)({}),
  Layer.mock(DictationJobs)({}),
  Layer.mock(HostStatsService)({}),
  Layer.mock(ProjectIconDiscovery)({}),
  Layer.mock(AccountLimitsService)({}),
  Layer.mock(CodexInstallation.CodexInstallation)({ managedDirectory: "/unused-managed-codex" }),
  Layer.mock(AntigravityInstallation.AntigravityInstallation)({
    managedDirectory: "/unused-managed-antigravity",
  }),
  Layer.mock(ServerSettings.ServerSettingsService)({
    getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
  }),
  Layer.mock(AnalyticsService.AnalyticsService)({ record: () => Effect.void }),
  FetchHttpClient.layer,
);

const decodeAuthorizationError = Schema.decodeUnknownSync(EnvironmentAuthorizationError);

const connectWorkloadRoute = Effect.fnUntraced(function* (token: string) {
  const authentication = yield* EnvironmentAuth.EnvironmentAuth;
  const auth = Layer.succeed(EnvironmentAuth.EnvironmentAuth, authentication);
  const routePorts = Layer.merge(unrelatedPorts, auth);
  const inbound = yield* Queue.make<string, Socket.SocketError>();
  const outbound = yield* Queue.make<string>();
  const socket = Socket.make({
    reader: Effect.succeed({
      pull: Queue.take(inbound).pipe(Effect.map((frame) => [frame] as const)),
      upgrade: () => Effect.void,
    }),
    writer: Effect.succeed({
      write: (value) => Queue.offer(outbound, String(value)).pipe(Effect.asVoid),
      writeAll: (values) =>
        Effect.forEach(values, (value) => Queue.offer(outbound, String(value)), {
          discard: true,
        }),
    }),
  });
  const base = HttpServerRequest.fromWeb(
    new Request(`http://fixture.test/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}`, {
      headers: { authorization: "Bearer " + token },
    }),
  );
  const request = Object.create(base) as HttpServerRequest.HttpServerRequest;
  Object.defineProperty(request, "upgrade", { value: Effect.succeed(socket) });
  const app = yield* HttpRouter.toHttpEffect(Ws.layer.pipe(Layer.provideMerge(routePorts)));
  const connection = yield* app.pipe(
    Effect.provide(routePorts),
    Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    Effect.scoped,
    Effect.forkScoped,
  );
  return { inbound, outbound, connection };
});

const controlHost = (state: "absent" | "running") =>
  WorkloadHost.WorkloadHost.of({
    manager: (unit) =>
      Effect.succeed({
        state,
        unit,
        controlGroup: null,
      }),
    resources: () => Effect.die("unused"),
    tailnet: Effect.succeed(null),
  });

const controlRouteAuthLayer = (
  bridge: WorkloadHostBridge.WorkloadHostBridge["Service"],
  host: WorkloadHost.WorkloadHost["Service"],
) =>
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-a")),
      }),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "mesura-control-route-" })),
    Layer.provideMerge(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(WorkloadHostBridge.WorkloadHostBridge, bridge),
        Layer.succeed(WorkloadHost.WorkloadHost, host),
      ),
    ),
  );

it.effect.each(
  (["start", "stop"] as const).flatMap((operation) =>
    (["revoke", "expire", "disconnect", "request-interrupt"] as const).map((mode) => ({
      operation,
      mode,
      name: `real ws cancels direct ${operation} on ${mode}`,
    })),
  ),
)("$name", ({ operation, mode }) =>
  Effect.gen(function* () {
    const queued = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    const gate = yield* Deferred.make<void>();
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    let dispatches = 0;
    let childPid: number | undefined;
    const pending = Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make("/usr/bin/python3", ["-u", "-c", "import sys; sys.stdin.read()"], {
            shell: false,
            env: {},
            extendEnv: false,
            forceKillAfter: "2 seconds",
            stderr: "ignore",
          }),
        );
        childPid = child.pid;
        yield* Deferred.succeed(queued, undefined);
        yield* Deferred.await(gate);
        dispatches++;
        return 0;
      }),
    ).pipe(
      Effect.mapError(
        (cause) => new WorkloadHostBridge.WorkloadBridgeError({ reason: "invalid-launch", cause }),
      ),
      Effect.ensuring(Deferred.succeed(released, undefined)),
    );
    const bridge = WorkloadHostBridge.WorkloadHostBridge.of({
      available: Effect.succeed(true),
      validateReplay: () =>
        operation === "start" ? pending.pipe(Effect.orDie, Effect.as(null)) : Effect.succeed(null),
      stop: () => pending,
      replay: () =>
        Effect.sync(() => {
          dispatches++;
          return 0;
        }),
    });
    const host = controlHost(operation === "start" ? "absent" : "running");
    yield* withControlFixture(({ record, threadId }) =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const issued = yield* sessions.issue({
          subject: "workload-rpc",
          scopes: [AuthEnvironmentMaintainScope, AuthDiagnosticsReadScope],
          ttl: Duration.seconds(20),
        });
        const unaffected = yield* sessions.issue({
          subject: "workload-rpc-unaffected",
          scopes: [AuthEnvironmentMaintainScope, AuthDiagnosticsReadScope],
          ttl: Duration.minutes(5),
        });
        const session = yield* sessions.verify(issued.token);
        const observeList = (
          connection: {
            inbound: Queue.Queue<string, Socket.SocketError>;
            outbound: Queue.Queue<string>;
          },
          id: string,
        ) =>
          Effect.gen(function* () {
            yield* Queue.offer(
              connection.inbound,
              JSON.stringify({
                _tag: "Request",
                id,
                tag: "workloads.list",
                payload: {},
                headers: [],
              }),
            );
            const response = JSON.parse(yield* Queue.take(connection.outbound));
            expect(response).toMatchObject({
              _tag: "Exit",
              requestId: id,
              exit: {
                _tag: "Success",
                value: {
                  workloads: [{ association: { state: "assigned", threadId } }],
                },
              },
            });
          });
        const primary = yield* connectWorkloadRoute(issued.token);
        const { inbound, outbound, connection } = primary;
        const other = yield* connectWorkloadRoute(unaffected.token);
        // Establish and observe the independent connection before cancellation.
        yield* observeList(other, "2");
        yield* Queue.offer(
          inbound,
          JSON.stringify({
            _tag: "Request",
            id: "1",
            tag: `workloads.${operation}`,
            payload: {
              recordId: record.recordKey,
              threadId,
            },
            headers: [],
          }),
        );
        yield* Effect.raceFirst(
          Deferred.await(queued),
          Fiber.join(connection).pipe(
            Effect.andThen(Effect.die("The route ended before the queued operation")),
          ),
        );
        if (mode === "revoke") yield* sessions.revoke(session.sessionId);
        else if (mode === "expire") yield* TestClock.adjust("21 seconds");
        else if (mode === "disconnect")
          yield* Queue.fail(
            inbound,
            new Socket.SocketError({
              reason: new Socket.SocketCloseError({ code: 1000, closeReason: "fixture closed" }),
            }),
          );
        // Interrupt the actual request frame. Interrupting the connection here
        // would test disconnect again and would miss per-request cancellation.
        else yield* Queue.offer(inbound, JSON.stringify({ _tag: "Interrupt", requestId: "1" }));
        yield* Deferred.await(released);
        yield* Deferred.succeed(gate, undefined);
        expect(dispatches).toBe(0);
        expect(childPid).toBeDefined();
        expect(yield* fs.exists(`/proc/${childPid}`)).toBe(false);
        if (mode === "request-interrupt") {
          const interruption = JSON.parse(yield* Queue.take(outbound));
          expect(interruption).toMatchObject({
            _tag: "Exit",
            requestId: "1",
            exit: { _tag: "Failure" },
          });
          yield* observeList(primary, "3");
        }
        yield* observeList(other, "4");
        yield* Queue.fail(
          other.inbound,
          new Socket.SocketError({
            reason: new Socket.SocketCloseError({ code: 1000, closeReason: "fixture closed" }),
          }),
        );
        yield* Fiber.join(other.connection);
        if (mode === "request-interrupt")
          yield* Queue.fail(
            inbound,
            new Socket.SocketError({
              reason: new Socket.SocketCloseError({ code: 1000, closeReason: "fixture closed" }),
            }),
          );
        yield* Fiber.join(connection);
      }),
    ).pipe(
      Effect.provide(controlRouteAuthLayer(bridge, host)),
      Effect.provideService(WorkloadHostBridge.WorkloadHostBridge, bridge),
      Effect.provideService(WorkloadHost.WorkloadHost, host),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(
  (["start", "stop"] as const).flatMap((operation) =>
    [
      { scopeName: "empty", scopes: [] },
      { scopeName: "diagnostics-only", scopes: [AuthDiagnosticsReadScope] },
      { scopeName: "orchestration-only", scopes: [AuthOrchestrationOperateScope] },
    ].map(({ scopeName, scopes }) => ({
      operation,
      scopes,
      name:
        "F2 control V2 real ws denies " +
        operation +
        " for " +
        scopeName +
        " before service or bridge entry",
    })),
  ),
)("$name", ({ operation, scopes }) =>
  withHostBridgeFixture((fixture) =>
    Effect.gen(function* () {
      const bridge = yield* WorkloadHostBridge.WorkloadHostBridge;
      const host = controlHost(operation === "start" ? "absent" : "running");
      return yield* withControlFixture(({ record, threadId }) =>
        Effect.gen(function* () {
          const WorkloadService = yield* Effect.promise(() => import("./WorkloadService.ts"));
          const service = yield* WorkloadService.WorkloadService;
          // RpcServer constructs the handler Effect before applying middleware.
          // Observe execution, then delegate to the actual suspended control work.
          const start = vi.fn(service.start);
          const stop = vi.fn(service.stop);
          const observedService = WorkloadService.WorkloadService.of({
            ...service,
            start: (input) => Effect.suspend(() => start(input)),
            stop: (input) => Effect.suspend(() => stop(input)),
          });
          const sessions = yield* SessionStore.SessionStore;
          const issued = yield* sessions.issue({
            subject: "workload-rpc-denied",
            scopes,
            ttl: Duration.minutes(5),
          });
          const verified = yield* sessions.verify(issued.token);
          expect(verified.scopes).toEqual(scopes);
          expect(verified.scopes).not.toContain(AuthEnvironmentMaintainScope);
          const route = yield* connectWorkloadRoute(issued.token).pipe(
            Effect.provideService(WorkloadService.WorkloadService, observedService),
          );
          yield* Queue.offer(
            route.inbound,
            JSON.stringify({
              _tag: "Request",
              id: "1",
              tag: `workloads.${operation}`,
              payload: {
                recordId: record.recordKey,
                threadId,
              },
              headers: [],
            }),
          );
          const response = JSON.parse(
            yield* Effect.raceFirst(
              Queue.take(route.outbound),
              Fiber.join(route.connection).pipe(
                Effect.andThen(Effect.die("The route ended before its authorization response")),
              ),
            ),
          );
          expect(response).toMatchObject({
            _tag: "Exit",
            requestId: "1",
            exit: {
              _tag: "Failure",
              cause: [
                {
                  _tag: "Fail",
                  error: {
                    _tag: "EnvironmentAuthorizationError",
                    requiredPermission: AuthEnvironmentMaintainScope,
                  },
                },
              ],
            },
          });
          expect(decodeAuthorizationError(response.exit.cause[0].error)).toBeInstanceOf(
            EnvironmentAuthorizationError,
          );
          expect(start).not.toHaveBeenCalled();
          expect(stop).not.toHaveBeenCalled();
          expect(fixture.children).toHaveLength(0);
          const fs = yield* FileSystem.FileSystem;
          // Both manager and replay wrapper write actions before target launch.
          expect(yield* fs.exists(fixture.actions)).toBe(false);
          yield* Queue.fail(
            route.inbound,
            new Socket.SocketError({
              reason: new Socket.SocketCloseError({ code: 1000, closeReason: "fixture closed" }),
            }),
          );
          yield* Fiber.join(route.connection);
        }),
      ).pipe(
        Effect.provide(controlRouteAuthLayer(bridge, host)),
        Effect.provideService(WorkloadHostBridge.WorkloadHostBridge, bridge),
        Effect.provideService(WorkloadHost.WorkloadHost, host),
      );
    }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([true, false])(
  "real workloads.list projects shared RAM only after diagnostics authorization (%s)",
  (authorized) =>
    Effect.gen(function* () {
      let reads = 0;
      const bridge = WorkloadHostBridge.WorkloadHostBridge.of({
        available: Effect.succeed(false),
        validateReplay: () => Effect.die("list invoked workload control"),
        stop: () => Effect.die("list invoked workload control"),
        replay: () => Effect.die("list invoked workload control"),
      });
      const host = controlHost("absent");
      yield* withControlFixture(
        ({ threadId }) =>
          Effect.gen(function* () {
            const sessions = yield* SessionStore.SessionStore;
            const issued = yield* sessions.issue({
              subject: "shared-ram-rpc",
              scopes: authorized ? [AuthDiagnosticsReadScope] : [],
              ttl: Duration.minutes(5),
            });
            const route = yield* connectWorkloadRoute(issued.token);
            yield* Effect.gen(function* () {
              yield* Queue.offer(
                route.inbound,
                JSON.stringify({
                  _tag: "Request",
                  id: "ram-list",
                  tag: "workloads.list",
                  payload: { threadId },
                  headers: [],
                }),
              );
              const response = JSON.parse(
                yield* Effect.raceFirst(
                  Queue.take(route.outbound),
                  Fiber.join(route.connection).pipe(
                    Effect.andThen(Effect.die("route ended before list response")),
                  ),
                ),
              );
              if (authorized) {
                expect(response).toMatchObject({
                  _tag: "Exit",
                  requestId: "ram-list",
                  exit: {
                    _tag: "Success",
                    value: {
                      sharedAgentRam: {
                        status: "available",
                        groups: [
                          {
                            groupId: "12345678-1234-4234-8234-123456789abc",
                            anonymousBytes: 0,
                            attachedThreadCount: 2,
                          },
                        ],
                      },
                    },
                  },
                });
                expect(reads).toBe(1);
                expect(JSON.stringify(response)).not.toMatch(
                  /private-provider-session|providerSessionId|launchToken|verifiedScopeKey/,
                );
              } else {
                expect(response).toMatchObject({
                  exit: {
                    _tag: "Failure",
                    cause: [
                      {
                        _tag: "Fail",
                        error: {
                          _tag: "EnvironmentAuthorizationError",
                          requiredPermission: AuthDiagnosticsReadScope,
                        },
                      },
                    ],
                  },
                });
                expect(reads).toBe(0);
              }
            }).pipe(
              Effect.ensuring(
                Queue.fail(
                  route.inbound,
                  new Socket.SocketError({
                    reason: new Socket.SocketCloseError({
                      code: 1000,
                      closeReason: "fixture closed",
                    }),
                  }),
                ),
              ),
            );
            yield* Fiber.join(route.connection);
          }),
        {
          read: (input) =>
            Effect.sync((): ProviderRuntimeResources.ProviderRuntimeResourceSummary => {
              reads++;
              expect(input?.threadId).toBe("thread:control-rpc");
              return {
                incomplete: false,
                groups: [
                  {
                    groupId: "12345678-1234-4234-8234-123456789abc",
                    driver: ProviderDriverKind.make("codex"),
                    instanceId: ProviderInstanceId.make("codex"),
                    providerSessionId: ProviderSessionId.make("private-provider-session"),
                    attachedThreadCount: 2,
                    status: "available",
                    anonymousBytes: 0,
                    sampledAt: "2026-10-13T00:00:00.000Z",
                    reason: null,
                  },
                ],
              };
            }),
        },
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            controlRouteAuthLayer(bridge, host),
            Layer.succeed(WorkloadHostBridge.WorkloadHostBridge, bridge),
            Layer.succeed(WorkloadHost.WorkloadHost, host),
          ),
        ),
      );
    }).pipe(Effect.scoped),
);
