/**
 * Mesura: the server-scope context `layerWsRpcMesura` is built on in tests,
 * with every service a test does not exercise replaced by an empty mock.
 * `presence` is the `ClientPresence` the handlers report into; by default an
 * empty mock, for tests that never report.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { FetchHttpClient } from "effect/http";

import * as ServerConfig from "./config.ts";
import { DictationJobs } from "./dictation/DictationJobs.ts";
import * as EditorSessionManager from "./editor/Manager.ts";
import * as FactoryRunTracker from "./factory/FactoryRunTracker.ts";
import * as FactorySnapshotStore from "./factory/FactorySnapshotStore.ts";
import * as FileManagerHost from "./fileManager/FileManagerHost.ts";
import { HostStatsService } from "./hostStats/HostStatsService.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearchEvidence from "./orchestration-v2/ThreadSearchEvidence.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import { ClientPresence } from "./push/ClientPresence.ts";
import { PushSubscriptions } from "./push/PushSubscriptions.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as TextGeneration from "./textGeneration/TextGeneration.ts";
import { AccountLimitsService } from "./usage/AccountLimitsService.ts";
import { VcsProvisioningService } from "./vcs/VcsProvisioningService.ts";
import * as WorkspaceFileWatcher from "./workspace/WorkspaceFileWatcher.ts";
import { layerMesuraServerScope } from "./wsMesura.ts";

/** The server-scope services, built once; `projectCreates` counts search-project creations. */
export const makeMesuraServerScope = Effect.fn("WsMesuraTestFixtures.makeServerScope")(function* (
  presence: Layer.Layer<ClientPresence> = Layer.mock(ClientPresence)({}),
) {
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
    ServerConfig.layerTest(process.cwd(), { prefix: "ws-mesura-" }),
  );
  const context = yield* Layer.build(
    Layer.mergeAll(layerMesuraServerScope, unused).pipe(
      Layer.provideMerge(presence),
      Layer.provideMerge(starterDependencies),
      Layer.provideMerge(NodeServices.layer),
    ),
  );
  return { context, projectCreates };
});

export type MesuraServerScope = Effect.Success<ReturnType<typeof makeMesuraServerScope>>;
