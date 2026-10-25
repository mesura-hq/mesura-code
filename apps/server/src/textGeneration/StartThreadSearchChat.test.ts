// Mesura: starting a search conversation (ADR-010). Entry point:
// `makeStartThreadSearchChat`, the effect the `startThreadSearchChat` RPC in
// `wsMesura.ts` calls. The project side is the real `ProjectService` over
// in-memory SQLite, so the hidden project, its creation receipt, project
// listing and project deletion are the production ones. Threads are created
// through `ThreadManagementService.dispatch`, faked here to record each
// `thread.create`; the orchestrator's thread creation has its own tests.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  ProjectId,
  ProviderInstanceId,
  THREAD_SEARCH_PROJECT_ID,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { projectFaviconResolverForPath } from "../project/testkit/projectFaviconResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import { VcsProvisioningService } from "../vcs/VcsProvisioningService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { makeStartThreadSearchChat } from "./StartThreadSearchChat.ts";

const TEXT_GENERATION_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4-mini",
} as const;

type ThreadCreateCommand = Extract<OrchestrationV2Command, { readonly type: "thread.create" }>;

const layerProjectDependencies = Layer.mergeAll(
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
  IdAllocator.layer,
  ThreadCommandExecutor.layer,
  Layer.succeed(WorkspacePaths.WorkspacePaths, {
    normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
      Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
  }),
).pipe(
  Layer.provideMerge(LegacyV1ThreadImporter.layer.pipe(Layer.provide(RuntimeLayer.layerEventSink))),
  Layer.provideMerge(
    ProjectEnrichmentService.layer.pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
            resolve: () => Effect.succeed(null),
          }),
          Layer.succeed(
            ProjectFaviconResolver.ProjectFaviconResolver,
            projectFaviconResolverForPath(() => Effect.succeed(null)),
          ),
        ),
      ),
    ),
  ),
  Layer.provideMerge(
    ServerSettings.layerTest({
      textGenerationModelSelection: TEXT_GENERATION_SELECTION,
      defaultRuntimeMode: "approval-required",
    }),
  ),
);

/** The production project service and stores, with thread creation recorded. */
const makeHarness = Effect.fn("StartThreadSearchChatTest.makeHarness")(function* () {
  const threadCreates = yield* Ref.make<ReadonlyArray<ThreadCreateCommand>>([]);
  const initializedRepositories = yield* Ref.make<ReadonlyArray<string>>([]);
  const layer = Layer.mergeAll(
    ProjectService.layer.pipe(Layer.provideMerge(layerProjectDependencies)),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      dispatch: (command) =>
        command.type === "thread.create"
          ? Ref.update(threadCreates, (recorded) => [...recorded, command]).pipe(
              Effect.as({ sequence: 1, storedEvents: [] }),
            )
          : Effect.die(`unexpected ${command.type}`),
    }),
    Layer.succeed(VcsProvisioningService, {
      initRepository: ({ cwd }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* Ref.update(initializedRepositories, (recorded) => [...recorded, cwd]);
          yield* fs.makeDirectory(path.join(cwd, ".git"), { recursive: true });
        }).pipe(Effect.orDie, Effect.provide(NodeServices.layer)),
    }),
  ).pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "thread-search-chat-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  const context = yield* Layer.build(layer);
  return { context, threadCreates, initializedRepositories };
});

const searchThreadCreated = (threadId: ThreadId) => {
  const createdAt = DateTime.makeUnsafe("2026-10-25T00:00:00.000Z");
  const providerInstanceId = TEXT_GENERATION_SELECTION.instanceId;
  const payload: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: THREAD_SEARCH_PROJECT_ID,
    title: "New search",
    providerInstanceId,
    modelSelection: TEXT_GENERATION_SELECTION,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  return {
    id: EventId.make(`created:${threadId}`),
    type: "thread.created" as const,
    threadId,
    providerInstanceId,
    occurredAt: createdAt,
    payload,
  };
};

it.effect(
  "start thread search chat spec: two concurrent starts create the search project once and one thread each",
  () =>
    Effect.gen(function* () {
      assert.isDefined(THREAD_SEARCH_PROJECT_ID);
      const harness = yield* makeHarness();
      const [first, second] = yield* Effect.gen(function* () {
        const start = yield* makeStartThreadSearchChat;
        return yield* Effect.all([start(), start()], { concurrency: 2 });
      }).pipe(Effect.provide(harness.context));

      assert.equal(first?.projectId, THREAD_SEARCH_PROJECT_ID);
      assert.equal(second?.projectId, THREAD_SEARCH_PROJECT_ID);
      assert.notEqual(first?.threadId, second?.threadId);

      const sql = yield* SqlClient.SqlClient.pipe(Effect.provide(harness.context));
      const created = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_events
        WHERE event_type = 'project.created' AND stream_id = ${THREAD_SEARCH_PROJECT_ID}
      `.pipe(Effect.provide(harness.context));
      assert.equal(created[0]?.count, 1);

      const project = yield* ProjectService.ProjectService.pipe(
        Effect.flatMap((service) => service.getById(THREAD_SEARCH_PROJECT_ID)),
        Effect.provide(harness.context),
      );
      assert.isTrue(Option.isSome(project));

      // The selection as settings hold it, with the defaults decoding adds.
      const configuredSelection = yield* ServerSettings.ServerSettingsService.pipe(
        Effect.flatMap((settings) => settings.getConfiguredTextGenerationModelSelection),
        Effect.provide(harness.context),
      );
      assert.equal(configuredSelection.model, TEXT_GENERATION_SELECTION.model);
      const threads = yield* Ref.get(harness.threadCreates);
      assert.deepEqual(
        threads.map((command) => command.threadId).toSorted(),
        [first?.threadId, second?.threadId].toSorted(),
      );
      for (const command of threads) {
        assert.equal(command.projectId, THREAD_SEARCH_PROJECT_ID);
        assert.deepEqual(command.modelSelection, configuredSelection);
        assert.equal(command.runtimeMode, "approval-required");
      }
      assert.notEqual(threads[0]?.commandId, threads[1]?.commandId);
    }),
);

it.effect(
  "start thread search chat spec: the search workspace tells the agent to search with find_threads",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const start = yield* makeStartThreadSearchChat;
        yield* start();
        yield* start();
      }).pipe(Effect.provide(harness.context));
      const project = yield* ProjectService.ProjectService.pipe(
        Effect.flatMap((service) => service.getById(THREAD_SEARCH_PROJECT_ID)),
        Effect.map(Option.getOrThrow),
        Effect.provide(harness.context),
      );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const instructions = yield* fs.readFileString(path.join(project.workspaceRoot, "AGENTS.md"));
      assert.include(instructions, "find_threads");
      assert.include(instructions, "untrusted data");
      // Checkpoints need a repository rooted in the workspace, made only once.
      assert.deepEqual(yield* Ref.get(harness.initializedRepositories), [project.workspaceRoot]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("start thread search chat spec: project listing leaves out the search project", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const listed = yield* Effect.gen(function* () {
      const start = yield* makeStartThreadSearchChat;
      yield* start();
      const projects = yield* ProjectService.ProjectService;
      yield* projects.create({
        commandId: CommandId.make("command:ordinary-project"),
        projectId: ProjectId.make("project-ordinary"),
        title: "Ordinary",
        workspaceRoot: "/work/ordinary",
      });
      return yield* projects.listPage({ cursor: 0, limit: 20 });
    }).pipe(Effect.provide(harness.context));
    // The ordinary project is listed, so an empty page cannot pass this spec.
    assert.deepEqual(
      listed.projects.map((project) => project.id),
      [ProjectId.make("project-ordinary")],
    );
  }),
);

it.effect(
  "start thread search chat spec: generic project deletion refuses the search project and keeps its threads",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const searchThreadId = ThreadId.make("thread-search-kept");
      yield* Effect.gen(function* () {
        const start = yield* makeStartThreadSearchChat;
        yield* start();
        const eventSink = yield* EventSink.EventSinkV2;
        yield* eventSink.write({ events: [searchThreadCreated(searchThreadId)] });
        const projects = yield* ProjectService.ProjectService;
        const refused = yield* projects
          .delete({
            commandId: CommandId.make("command:delete-search-project"),
            projectId: THREAD_SEARCH_PROJECT_ID,
            force: true,
          })
          .pipe(Effect.flip);
        assert.isDefined(refused);
        assert.isTrue(Option.isSome(yield* projects.getById(THREAD_SEARCH_PROJECT_ID)));
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const thread = yield* projections.getThreadProjection(searchThreadId);
        assert.isNull(thread.thread.deletedAt);
      }).pipe(Effect.provide(harness.context));
    }),
);
