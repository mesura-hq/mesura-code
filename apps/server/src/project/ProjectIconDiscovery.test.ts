// @effect-diagnostics nodeBuiltinImport:off
// Entry point: `makeProjectIconDiscovery`, the service behind the
// `projectIcons.preview` and `projectIcons.discover` RPCs, running against the
// real orchestration engine, projection pipeline and snapshot query on a SQLite
// file. The model is the injected selector; each test counts its invocations.
// A second runtime on the same file is a server restart.
//
// Project icon discovery phase 1, acceptance criteria 1, 2, 3, 5, 6 (server
// interruption), 7 (end to end) and 8 (persisted outcomes, unavailable Luna).
// Criteria 4 and 6 (Stop, client closure) live with the dialog that owns the
// batch: apps/web/src/AppRoot.projectIconDiscovery.fence.test.tsx.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  DEFAULT_TEXT_GENERATION_MODEL,
  type OrchestrationCommand,
  type ServerProvider,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { describe, expect, it } from "@effect/vitest";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import type { ProjectIconCandidate } from "./ProjectIconCandidates.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import {
  makeProjectIconDiscovery,
  ProjectIconSelectionUnavailable,
  selectProjectIconInstance,
  type ProjectIconInstanceCandidate,
} from "./ProjectIconDiscovery.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
import * as T3ProjectFileLoader from "./T3ProjectFileLoader.ts";

const NOW = "2026-10-11T00:00:00.000Z";
const BRAND_ICON = "web/public/brand-logo.svg";

interface Selection {
  readonly path: string | null;
  readonly reason: string;
}
type SelectInput = {
  readonly project: { readonly id: ProjectId; readonly workspaceRoot: string };
  readonly candidates: ReadonlyArray<ProjectIconCandidate>;
};
type Selector = (input: SelectInput) => Effect.Effect<Selection>;

/** The durable discovery state the phase adds to a project. */
interface DiscoveryState {
  readonly generation: number;
  readonly jobToken: string | null;
  readonly status: string;
  readonly path: string | null;
  readonly reason: string;
}
const discoveryOf = (project: OrchestrationProjectShell | null): DiscoveryState | null =>
  (project as { iconDiscovery?: DiscoveryState | null } | null)?.iconDiscovery ?? null;

function orchestrationLayer(databasePath: string) {
  return Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
    ProjectFaviconResolver.layer.pipe(
      Layer.provide(WorkspacePaths.layer),
      Layer.provide(T3ProjectFileLoader.layer),
    ),
  ).pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(makeSqlitePersistenceLive(databasePath)),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "mesura-icon-discovery-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}

const temporaryDirectory = (prefix: string) =>
  Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
    fs.makeTempDirectoryScoped({ prefix }),
  );

const writeFile = Effect.fnUntraced(function* (root: string, relative: string) {
  const fs = yield* FileSystem.FileSystem;
  const target = NodePath.join(root, relative);
  yield* fs.makeDirectory(NodePath.dirname(target), { recursive: true });
  yield* fs.writeFileString(target, "<svg/>");
});

const removeDirectory = (directory: string) =>
  Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
    fs.remove(directory, { recursive: true }),
  );

/**
 * One server: an engine on the database file and a discovery service whose
 * selector counts every model invocation. It lives in its own scope; `stop`
 * closes that scope, which is a server stop.
 */
const startServer = Effect.fnUntraced(function* (
  databasePath: string,
  options: {
    readonly select?: Selector;
    readonly unavailable?: string;
  } = {},
) {
  const scope = yield* Scope.fork(yield* Scope.Scope);
  const context = yield* Layer.buildWithScope(orchestrationLayer(databasePath), scope);
  const run = <A, E>(
    effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof orchestrationLayer>>>,
  ) => effect.pipe(Effect.provideContext(context));
  const calls: SelectInput[] = [];
  const select: Selector =
    options.select ?? (() => Effect.succeed({ path: BRAND_ICON, reason: "The brand mark." }));
  const discovery = yield* run(
    makeProjectIconDiscovery({
      resolveSelector:
        options.unavailable === undefined
          ? Effect.succeed((input: SelectInput) =>
              Effect.suspend(() => {
                calls.push(input);
                return select(input);
              }),
            )
          : Effect.fail(new ProjectIconSelectionUnavailable({ detail: options.unavailable })),
    }).pipe(Scope.provide(scope)),
  );
  const engine = yield* run(Effect.service(OrchestrationEngineService));
  const snapshots = yield* run(Effect.service(ProjectionSnapshotQuery));
  return {
    calls,
    run,
    dispatch: (command: OrchestrationCommand) => run(engine.dispatch(command)),
    project: (projectId: ProjectId) =>
      run(snapshots.getProjectShellById(projectId).pipe(Effect.map(Option.getOrNull))),
    discover: (projectId: ProjectId, requestId: string) =>
      run(discovery.discover({ projectId, requestId: CommandId.make(requestId) })),
    preview: (projectIds?: ReadonlyArray<ProjectId>) => run(discovery.preview(projectIds)),
    drain: () => run(discovery.drain),
    stop: () => Scope.close(scope, Exit.void),
  };
});
type Server = Effect.Success<ReturnType<typeof startServer>>;

const addProject = Effect.fnUntraced(function* (
  server: Server,
  name: string,
  files: ReadonlyArray<string> = [BRAND_ICON],
) {
  // The workspace sits inside the scoped directory, so a test can delete it
  // (an invalid root) without breaking the scope's cleanup.
  const root = NodePath.join(yield* temporaryDirectory(`mesura-icon-${name}-`), "workspace");
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(root);
  for (const file of files) yield* writeFile(root, file);
  const projectId = ProjectId.make(`project-${name}`);
  yield* server.dispatch({
    type: "project.create",
    commandId: CommandId.make(`cmd-create-${name}`),
    projectId,
    title: name,
    workspaceRoot: root,
    createdAt: NOW,
  });
  return { projectId, root };
});

const newDatabase = () =>
  Effect.map(temporaryDirectory("mesura-icon-db-"), (directory) =>
    NodePath.join(directory, "state.sqlite"),
  );

it.layer(NodeServices.layer)("project icon discovery service fence", (it) => {
  describe("criterion 1: lifecycle silence", () => {
    it.effect(
      "icon discovery fence: adding projects, threads, turns and resets invoke no model",
      () =>
        Effect.gen(function* () {
          const server = yield* startServer(yield* newDatabase());
          const { projectId } = yield* addProject(server, "lifecycle");
          const threadId = ThreadId.make("thread-lifecycle");
          yield* server.dispatch({
            type: "thread.create",
            commandId: CommandId.make("cmd-lifecycle-thread"),
            threadId,
            projectId,
            title: "Lifecycle",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt: NOW,
          });
          yield* server.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-lifecycle-turn"),
            threadId,
            message: {
              messageId: MessageId.make("msg-lifecycle"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: NOW,
          });
          yield* server.dispatch({
            type: "project.meta.update",
            commandId: CommandId.make("cmd-lifecycle-reset"),
            projectId,
            faviconPath: null,
            projectIcon: null,
          });
          yield* server.drain();
          expect(server.calls).toHaveLength(0);
          expect(discoveryOf(yield* server.project(projectId))?.jobToken ?? null).toBeNull();
        }).pipe(Effect.scoped),
    );
  });

  describe("criterion 2: read-only preview", () => {
    it.effect(
      "icon discovery fence: preview reports each project's state without a model or a job",
      () =>
        Effect.gen(function* () {
          const server = yield* startServer(yield* newDatabase());
          const ready = yield* addProject(server, "preview-ready");
          const builtIn = yield* addProject(server, "preview-built-in", [
            "favicon.svg",
            BRAND_ICON,
          ]);
          const empty = yield* addProject(server, "preview-empty", []);
          const stale = yield* addProject(server, "preview-stale");
          yield* server.dispatch({
            type: "project.meta.update",
            commandId: CommandId.make("cmd-preview-stale"),
            projectId: stale.projectId,
            faviconPath: "assets/deleted-logo.svg",
          });
          const missing = yield* addProject(server, "preview-missing-root");
          yield* removeDirectory(missing.root);

          const previews = yield* server.preview();
          const byId = new Map(previews.map((preview) => [preview.projectId, preview]));
          expect(byId.get(ready.projectId)).toMatchObject({ status: "ready", candidateCount: 1 });
          expect(byId.get(builtIn.projectId)).toMatchObject({ status: "existing" });
          expect(byId.get(empty.projectId)).toMatchObject({ status: "empty", candidateCount: 0 });
          // A saved path that no longer resolves is not a displayed icon.
          expect(byId.get(stale.projectId)).toMatchObject({ status: "ready" });
          expect(byId.get(missing.projectId)).toMatchObject({ status: "failed" });

          yield* server.drain();
          expect(server.calls).toHaveLength(0);
          for (const project of [ready, builtIn, empty, stale]) {
            expect(discoveryOf(yield* server.project(project.projectId))).toBeNull();
          }
          expect((yield* server.project(ready.projectId))?.faviconPath ?? null).toBeNull();
        }).pipe(Effect.scoped),
    );

    it.effect("icon discovery fence: a previous no-match stays eligible in the preview", () =>
      Effect.gen(function* () {
        const server = yield* startServer(yield* newDatabase(), {
          select: () => Effect.succeed({ path: null, reason: "Only framework assets." }),
        });
        const { projectId } = yield* addProject(server, "preview-after-none");
        yield* server.discover(projectId, "cmd-preview-after-none");
        yield* server.drain();
        expect(discoveryOf(yield* server.project(projectId))?.status).toBe("none");
        expect(yield* server.preview([projectId])).toMatchObject([{ projectId, status: "ready" }]);
      }).pipe(Effect.scoped),
    );
  });

  describe("criterion 3: one project and explicit retry", () => {
    it.effect(
      "icon discovery fence: discover returns a job token and saves the selected image",
      () =>
        Effect.gen(function* () {
          const server = yield* startServer(yield* newDatabase());
          const { projectId } = yield* addProject(server, "single");
          const accepted = yield* server.discover(projectId, "cmd-single");
          expect(accepted).toMatchObject({ projectId, jobToken: "cmd-single" });
          yield* server.drain();
          expect(server.calls).toHaveLength(1);
          expect(server.calls[0]?.candidates.map((candidate) => candidate.path)).toEqual([
            BRAND_ICON,
          ]);
          const project = yield* server.project(projectId);
          expect(project?.faviconPath).toBe(BRAND_ICON);
          expect(discoveryOf(project)).toMatchObject({
            jobToken: "cmd-single",
            status: "selected",
            path: BRAND_ICON,
          });
        }).pipe(Effect.scoped),
    );

    it.effect("icon discovery fence: an explicit repeat retries a previous no-match", () =>
      Effect.gen(function* () {
        let answer: Selection = { path: null, reason: "No brand mark yet." };
        const server = yield* startServer(yield* newDatabase(), {
          select: () => Effect.sync(() => answer),
        });
        const { projectId } = yield* addProject(server, "retry");
        yield* server.discover(projectId, "cmd-retry-1");
        yield* server.drain();
        expect(discoveryOf(yield* server.project(projectId))?.status).toBe("none");

        answer = { path: BRAND_ICON, reason: "The brand mark arrived." };
        const second = yield* server.discover(projectId, "cmd-retry-2");
        expect(second.jobToken).toBe("cmd-retry-2");
        yield* server.drain();
        expect(server.calls).toHaveLength(2);
        expect((yield* server.project(projectId))?.faviconPath).toBe(BRAND_ICON);
      }).pipe(Effect.scoped),
    );

    it.effect("icon discovery fence: a retried transport request runs one job", () =>
      Effect.gen(function* () {
        const server = yield* startServer(yield* newDatabase());
        const { projectId } = yield* addProject(server, "transport-retry");
        const first = yield* server.discover(projectId, "cmd-transport");
        const retried = yield* server.discover(projectId, "cmd-transport");
        expect(retried.jobToken).toBe(first.jobToken);
        yield* server.drain();
        expect(server.calls).toHaveLength(1);
      }).pipe(Effect.scoped),
    );

    it.effect(
      "icon discovery fence: overlapping requests for one project join the active job",
      () =>
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>();
          const started = yield* Deferred.make<void>();
          const server = yield* startServer(yield* newDatabase(), {
            select: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as({ path: BRAND_ICON, reason: "Brand mark." }),
              ),
          });
          const { projectId } = yield* addProject(server, "join");
          const first = yield* server.discover(projectId, "cmd-join-1");
          yield* server.run(Deferred.await(started));
          const second = yield* server.discover(projectId, "cmd-join-2");
          expect(second.jobToken).toBe(first.jobToken);
          yield* server.run(Deferred.succeed(release, undefined));
          yield* server.drain();
          expect(server.calls).toHaveLength(1);
        }).pipe(Effect.scoped),
    );
  });

  describe("criterion 4: sequential execution", () => {
    it.effect("icon discovery fence: one environment runs one model call at a time", () =>
      Effect.gen(function* () {
        const gate = Effect.all({ started: Deferred.make<void>(), release: Deferred.make<void>() });
        const gates = new Map<string, Effect.Success<typeof gate>>();
        const started: string[] = [];
        let active = 0;
        let maximum = 0;
        const server = yield* startServer(yield* newDatabase(), {
          select: ({ project }) =>
            Effect.gen(function* () {
              active += 1;
              maximum = Math.max(maximum, active);
              started.push(project.id);
              const projectGate = gates.get(project.id)!;
              yield* Deferred.succeed(projectGate.started, undefined);
              yield* Deferred.await(projectGate.release);
              active -= 1;
              return { path: BRAND_ICON, reason: "Brand mark." };
            }),
        });
        const first = yield* addProject(server, "sequential-1");
        const second = yield* addProject(server, "sequential-2");
        gates.set(first.projectId, yield* gate);
        gates.set(second.projectId, yield* gate);
        yield* server.discover(first.projectId, "cmd-sequential-1");
        yield* server.discover(second.projectId, "cmd-sequential-2");
        yield* server.run(Deferred.await(gates.get(first.projectId)!.started));
        expect(started).toEqual([first.projectId]);
        yield* server.run(Deferred.succeed(gates.get(first.projectId)!.release, undefined));
        yield* server.run(Deferred.await(gates.get(second.projectId)!.started));
        yield* server.run(Deferred.succeed(gates.get(second.projectId)!.release, undefined));
        yield* server.drain();
        expect(started).toEqual([first.projectId, second.projectId]);
        expect(maximum).toBe(1);
      }).pipe(Effect.scoped),
    );

    it.effect("icon discovery fence: a project that gained an icon after preview is skipped", () =>
      Effect.gen(function* () {
        const server = yield* startServer(yield* newDatabase());
        const { projectId } = yield* addProject(server, "changed-after-preview");
        expect(yield* server.preview([projectId])).toMatchObject([{ status: "ready" }]);
        yield* server.dispatch({
          type: "project.meta.update",
          commandId: CommandId.make("cmd-changed-after-preview"),
          projectId,
          projectIcon: { kind: "emoji", emoji: "🚀" },
        });
        yield* server.discover(projectId, "cmd-changed-after-preview-run");
        yield* server.drain();
        expect(server.calls).toHaveLength(0);
        expect(discoveryOf(yield* server.project(projectId))?.status).toBe("existing");
      }).pipe(Effect.scoped),
    );
  });

  describe("criterion 5: no model without a reason to run it", () => {
    it.effect("icon discovery fence: an effective icon makes zero model calls", () =>
      Effect.gen(function* () {
        const server = yield* startServer(yield* newDatabase());
        const custom = yield* addProject(server, "effective-custom");
        yield* server.dispatch({
          type: "project.meta.update",
          commandId: CommandId.make("cmd-effective-custom"),
          projectId: custom.projectId,
          projectIcon: { kind: "emoji", emoji: "🚀" },
        });
        const builtIn = yield* addProject(server, "effective-built-in", [
          "favicon.svg",
          BRAND_ICON,
        ]);
        const saved = yield* addProject(server, "effective-saved");
        yield* server.dispatch({
          type: "project.meta.update",
          commandId: CommandId.make("cmd-effective-saved"),
          projectId: saved.projectId,
          faviconPath: BRAND_ICON,
        });
        for (const project of [custom, builtIn, saved]) {
          yield* server.discover(project.projectId, `cmd-run-${project.projectId}`);
        }
        yield* server.drain();
        expect(server.calls).toHaveLength(0);
        for (const project of [custom, builtIn, saved]) {
          expect(discoveryOf(yield* server.project(project.projectId))?.status).toBe("existing");
        }
        expect((yield* server.project(builtIn.projectId))?.faviconPath ?? null).toBeNull();
        expect((yield* server.project(saved.projectId))?.faviconPath).toBe(BRAND_ICON);
      }).pipe(Effect.scoped),
    );

    it.effect("icon discovery fence: no candidate images make zero model calls", () =>
      Effect.gen(function* () {
        const server = yield* startServer(yield* newDatabase());
        const { projectId } = yield* addProject(server, "no-candidates", ["README.md"]);
        yield* server.discover(projectId, "cmd-no-candidates");
        yield* server.drain();
        expect(server.calls).toHaveLength(0);
        expect(discoveryOf(yield* server.project(projectId))).toMatchObject({
          status: "empty",
          path: null,
        });
      }).pipe(Effect.scoped),
    );

    it.effect("icon discovery fence: an invalid root makes zero model calls", () =>
      Effect.gen(function* () {
        const server = yield* startServer(yield* newDatabase());
        const { projectId, root } = yield* addProject(server, "invalid-root");
        yield* removeDirectory(root);
        yield* server.discover(projectId, "cmd-invalid-root");
        yield* server.drain();
        expect(server.calls).toHaveLength(0);
        expect(discoveryOf(yield* server.project(projectId))?.status).toBe("failed");
      }).pipe(Effect.scoped),
    );

    it.effect("icon discovery fence: a selection outside the candidates saves nothing", () =>
      Effect.gen(function* () {
        const server = yield* startServer(yield* newDatabase(), {
          select: () => Effect.succeed({ path: "../outside.svg", reason: "Invented." }),
        });
        const { projectId } = yield* addProject(server, "invented-selection");
        yield* server.discover(projectId, "cmd-invented-selection");
        yield* server.drain();
        const project = yield* server.project(projectId);
        expect(project?.faviconPath ?? null).toBeNull();
        expect(discoveryOf(project)?.status).toBe("failed");
      }).pipe(Effect.scoped),
    );
  });

  describe("criterion 6: server interruption", () => {
    it.effect(
      "icon discovery fence: a restart marks the running job interrupted and runs nothing",
      () =>
        Effect.gen(function* () {
          const databasePath = yield* newDatabase();
          const started = yield* Deferred.make<void>();
          const first = yield* startServer(databasePath, {
            select: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          });
          const running = yield* addProject(first, "interrupted-running");
          yield* first.discover(running.projectId, "cmd-interrupted-running");
          yield* first.run(Deferred.await(started));
          expect(discoveryOf(yield* first.project(running.projectId))?.status).toBe("running");
          yield* first.stop();

          const second = yield* startServer(databasePath);
          yield* second.drain();
          expect(second.calls).toHaveLength(0);
          const project = yield* second.project(running.projectId);
          expect(project?.faviconPath ?? null).toBeNull();
          expect(discoveryOf(project)).toMatchObject({
            jobToken: "cmd-interrupted-running",
            status: "interrupted",
          });
        }).pipe(Effect.scoped),
    );

    it.effect(
      "icon discovery fence: a pending job claimed before a crash is interrupted on startup",
      () =>
        Effect.gen(function* () {
          const databasePath = yield* newDatabase();
          const first = yield* startServer(databasePath);
          const pending = yield* addProject(first, "interrupted-pending");
          // A claim persisted without its worker: the crash happened between the two.
          yield* first.dispatch({
            type: "project.icon-discovery.request",
            commandId: CommandId.make("cmd-interrupted-pending"),
            projectId: pending.projectId,
            createdAt: NOW,
          } as unknown as OrchestrationCommand);
          yield* first.stop();

          const second = yield* startServer(databasePath);
          yield* second.drain();
          expect(second.calls).toHaveLength(0);
          expect(discoveryOf(yield* second.project(pending.projectId))?.status).toBe("interrupted");
        }).pipe(Effect.scoped),
    );
  });

  describe("criterion 7: protected results end to end", () => {
    it.effect("icon discovery fence: a reset while Luna runs keeps the reset", () =>
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        const server = yield* startServer(yield* newDatabase(), {
          select: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ path: BRAND_ICON, reason: "Brand mark." }),
            ),
        });
        const { projectId } = yield* addProject(server, "reset-race");
        yield* server.discover(projectId, "cmd-reset-race");
        yield* server.run(Deferred.await(started));
        yield* server.dispatch({
          type: "project.meta.update",
          commandId: CommandId.make("cmd-reset-race-reset"),
          projectId,
          faviconPath: null,
          projectIcon: null,
        });
        yield* server.run(Deferred.succeed(release, undefined));
        yield* server.drain();
        const project = yield* server.project(projectId);
        expect(project?.faviconPath ?? null).toBeNull();
        expect(discoveryOf(project)?.status).toBe("superseded");
      }).pipe(Effect.scoped),
    );
  });

  describe("criterion 8: outcomes reach the client, unavailable Luna", () => {
    it.effect(
      "icon discovery fence: the outcome persists in the project projection across a restart",
      () =>
        Effect.gen(function* () {
          const databasePath = yield* newDatabase();
          const first = yield* startServer(databasePath);
          const { projectId } = yield* addProject(first, "persisted");
          yield* first.discover(projectId, "cmd-persisted");
          yield* first.drain();
          yield* first.stop();

          const second = yield* startServer(databasePath);
          const project = yield* second.project(projectId);
          expect(project?.faviconPath).toBe(BRAND_ICON);
          expect(discoveryOf(project)).toMatchObject({
            jobToken: "cmd-persisted",
            status: "selected",
            path: BRAND_ICON,
          });
          expect(second.calls).toHaveLength(0);
        }).pipe(Effect.scoped),
    );

    it.effect(
      "icon discovery fence: discover answers before Luna finishes and chat keeps working",
      () =>
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>();
          const started = yield* Deferred.make<void>();
          const server = yield* startServer(yield* newDatabase(), {
            select: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as({ path: BRAND_ICON, reason: "Brand mark." }),
              ),
          });
          const { projectId } = yield* addProject(server, "non-blocking");
          const accepted = yield* server.discover(projectId, "cmd-non-blocking");
          expect(accepted.jobToken).toBe("cmd-non-blocking");
          yield* server.run(Deferred.await(started));
          expect(discoveryOf(yield* server.project(projectId))?.status).toBe("running");
          yield* server.dispatch({
            type: "thread.create",
            commandId: CommandId.make("cmd-non-blocking-thread"),
            threadId: ThreadId.make("thread-non-blocking"),
            projectId,
            title: "Chat while Luna runs",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt: NOW,
          });
          yield* server.run(Deferred.succeed(release, undefined));
          yield* server.drain();
          expect(discoveryOf(yield* server.project(projectId))?.status).toBe("selected");
        }).pipe(Effect.scoped),
    );

    it.effect("icon discovery fence: unavailable Luna support records an accurate outcome", () =>
      Effect.gen(function* () {
        const server = yield* startServer(yield* newDatabase(), {
          unavailable: "No enabled Codex instance supports Luna.",
        });
        const { projectId } = yield* addProject(server, "unavailable");
        yield* server.discover(projectId, "cmd-unavailable");
        yield* server.drain();
        expect(server.calls).toHaveLength(0);
        const project = yield* server.project(projectId);
        expect(project?.faviconPath ?? null).toBeNull();
        expect(discoveryOf(project)).toMatchObject({
          status: "unavailable",
          reason: expect.stringContaining("No enabled Codex instance supports Luna."),
        });
      }).pipe(Effect.scoped),
    );
  });

  describe("Luna instance selection", () => {
    const instance = (
      id: string,
      options: {
        enabled?: boolean;
        supported?: boolean;
        provider?: Partial<ServerProvider>;
      } = {},
    ): ProjectIconInstanceCandidate => ({
      instance: {
        instanceId: ProviderInstanceId.make(id),
        enabled: options.enabled ?? true,
        ...(options.supported === false
          ? {}
          : { selectProjectIcon: () => Effect.succeed({ path: null, reason: id }) }),
      } as unknown as ProviderInstance,
      provider: {
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        models: [{ slug: DEFAULT_TEXT_GENERATION_MODEL, name: "Luna" }],
        ...options.provider,
      } as unknown as ServerProvider,
    });

    it("icon discovery fence: the configured Codex default wins over settings order", () => {
      const chosen = selectProjectIconInstance(
        [instance("codex"), instance("codex-work")],
        ProviderInstanceId.make("codex-work"),
      );
      expect(chosen?.instanceId).toBe("codex-work");
    });

    it("icon discovery fence: settings order picks the first enabled supporting instance", () => {
      const chosen = selectProjectIconInstance(
        [
          instance("claude", { supported: false }),
          instance("codex-off", { enabled: false }),
          instance("codex-second"),
        ],
        ProviderInstanceId.make("claude"),
      );
      expect(chosen?.instanceId).toBe("codex-second");
    });

    it("icon discovery fence: no supporting instance means unavailable", () => {
      expect(
        selectProjectIconInstance(
          [instance("claude", { supported: false }), instance("codex-off", { enabled: false })],
          null,
        ),
      ).toBeNull();
    });

    it("icon discovery rework: a preferred instance without Luna yields to one with it", () => {
      const chosen = selectProjectIconInstance(
        [instance("codex-no-luna", { provider: { models: [] } }), instance("codex-with-luna")],
        ProviderInstanceId.make("codex-no-luna"),
      );
      expect(chosen?.instanceId).toBe("codex-with-luna");
    });

    it("icon discovery rework: a signed-out or failing preferred instance is skipped", () => {
      const chosen = selectProjectIconInstance(
        [
          instance("codex-signed-out", { provider: { auth: { status: "unauthenticated" } } }),
          instance("codex-error", { provider: { status: "error" } }),
          instance("codex-ready"),
        ],
        ProviderInstanceId.make("codex-signed-out"),
      );
      expect(chosen?.instanceId).toBe("codex-ready");
      expect(
        selectProjectIconInstance(
          [instance("codex-signed-out", { provider: { auth: { status: "unauthenticated" } } })],
          null,
        ),
      ).toBeNull();
    });
  });

  describe("review findings", () => {
    it.effect("icon discovery rework: a queued job reset before it runs makes no model call", () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const server = yield* startServer(yield* newDatabase(), {
          select: ({ project }) =>
            project.id === ProjectId.make("project-held")
              ? Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as({ path: null, reason: "No mark." }),
                )
              : Effect.succeed({ path: BRAND_ICON, reason: "Brand mark." }),
        });
        const held = yield* addProject(server, "held");
        const reset = yield* addProject(server, "queued-reset");
        const moved = yield* addProject(server, "queued-moved");
        const movedTo = NodePath.join(yield* temporaryDirectory("mesura-icon-moved-"), "workspace");
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(movedTo);
        yield* writeFile(movedTo, BRAND_ICON);
        yield* server.discover(held.projectId, "cmd-held");
        yield* server.run(Deferred.await(started));
        yield* server.discover(reset.projectId, "cmd-queued-reset");
        yield* server.discover(moved.projectId, "cmd-queued-moved");
        yield* server.dispatch({
          type: "project.meta.update",
          commandId: CommandId.make("cmd-queued-reset-update"),
          projectId: reset.projectId,
          faviconPath: null,
          projectIcon: null,
        });
        yield* server.dispatch({
          type: "project.meta.update",
          commandId: CommandId.make("cmd-queued-moved-update"),
          projectId: moved.projectId,
          workspaceRoot: movedTo,
        });
        yield* Deferred.succeed(release, undefined);
        yield* server.drain();
        expect(server.calls.map((call) => call.project.id)).toEqual([held.projectId]);
        for (const project of [reset, moved]) {
          const current = yield* server.project(project.projectId);
          expect(current?.faviconPath ?? null).toBeNull();
          expect(discoveryOf(current)?.status).toBe("superseded");
        }
      }).pipe(Effect.scoped),
    );

    it.effect("icon discovery rework: a favicon added while Luna runs is kept", () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const server = yield* startServer(yield* newDatabase(), {
          select: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ path: BRAND_ICON, reason: "Brand mark." }),
            ),
        });
        const { projectId, root } = yield* addProject(server, "favicon-appears");
        // A preview first caches the resolver's miss for this root.
        expect(yield* server.preview([projectId])).toMatchObject([{ status: "ready" }]);
        yield* server.discover(projectId, "cmd-favicon-appears");
        yield* server.run(Deferred.await(started));
        yield* writeFile(root, "favicon.svg");
        yield* Deferred.succeed(release, undefined);
        yield* server.drain();
        const project = yield* server.project(projectId);
        expect(project?.faviconPath ?? null).toBeNull();
        expect(discoveryOf(project)?.status).toBe("existing");
      }).pipe(Effect.scoped),
    );

    it.effect("icon discovery rework: a request cancelled after it persists still runs once", () =>
      Effect.gen(function* () {
        const databasePath = yield* newDatabase();
        const server = yield* startServer(databasePath);
        const { projectId } = yield* addProject(server, "cancelled-request");
        const persisted = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const engine = yield* server.run(Effect.service(OrchestrationEngineService));
        let calls = 0;
        // The RPC is cancelled while its request command is persisting.
        const discovery = yield* server.run(
          makeProjectIconDiscovery({
            resolveSelector: Effect.succeed(() =>
              Effect.sync(() => {
                calls += 1;
                return { path: null, reason: "No mark." };
              }),
            ),
          }).pipe(
            Effect.provideService(OrchestrationEngineService, {
              ...engine,
              dispatch: (command) =>
                engine
                  .dispatch(command)
                  .pipe(
                    Effect.tap(() =>
                      command.commandId === "cmd-cancelled-rpc"
                        ? Deferred.succeed(persisted, undefined).pipe(
                            Effect.andThen(Deferred.await(resume)),
                          )
                        : Effect.void,
                    ),
                  ),
            }),
            Scope.provide(yield* Scope.Scope),
          ),
        );
        const rpc = yield* server
          .run(discovery.discover({ projectId, requestId: CommandId.make("cmd-cancelled-rpc") }))
          .pipe(Effect.forkScoped);
        yield* Deferred.await(persisted);
        // `interruptUnsafe` records the cancellation on the RPC fiber at once,
        // so it is in place before the request's dispatch returns. An
        // interruptible discover dies here; the real one finishes its claim
        // first and is interrupted only when that region ends.
        yield* Effect.sync(() => rpc.interruptUnsafe());
        yield* Deferred.succeed(resume, undefined);
        const rpcExit = yield* Fiber.await(rpc);
        expect(Exit.hasInterrupts(rpcExit), "the RPC itself ends cancelled").toBe(true);
        yield* server.run(discovery.drain);
        expect(calls).toBe(1);
        expect(discoveryOf(yield* server.project(projectId))).toMatchObject({
          jobToken: "cmd-cancelled-rpc",
          status: "none",
        });
      }).pipe(Effect.scoped),
    );

    it.effect("icon discovery rework: a later request adopts a pending job no worker took", () =>
      Effect.gen(function* () {
        const server = yield* startServer(yield* newDatabase());
        const { projectId } = yield* addProject(server, "orphaned-pending");
        // The request persisted, but its RPC never reached the worker.
        yield* server.dispatch({
          type: "project.icon-discovery.request",
          commandId: CommandId.make("cmd-orphaned"),
          projectId,
          createdAt: NOW,
        } as unknown as OrchestrationCommand);
        const joined = yield* server.discover(projectId, "cmd-orphaned-join");
        expect(joined.jobToken).toBe("cmd-orphaned");
        yield* server.drain();
        expect(server.calls).toHaveLength(1);
        expect(discoveryOf(yield* server.project(projectId))?.status).toBe("selected");
      }).pipe(Effect.scoped),
    );
    it.effect(
      "icon discovery regression: the acknowledgement carries the job's persisted generation",
      () =>
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>();
          const started = yield* Deferred.make<void>();
          const server = yield* startServer(yield* newDatabase(), {
            select: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as({ path: null, reason: "No mark." }),
              ),
          });
          const { projectId } = yield* addProject(server, "acknowledged-generation");
          const first = yield* server.discover(projectId, "cmd-generation-1");
          yield* server.run(Deferred.await(started));
          expect(first.generation).toBe(discoveryOf(yield* server.project(projectId))?.generation);
          // A request that joins the running job is told that job's generation.
          const joined = yield* server.discover(projectId, "cmd-generation-join");
          expect(joined).toEqual(first);
          yield* Deferred.succeed(release, undefined);
          yield* server.drain();
          // A deliberate repeat after the outcome claims a later generation.
          const repeated = yield* server.discover(projectId, "cmd-generation-2");
          expect(repeated.jobToken).toBe("cmd-generation-2");
          expect(repeated.generation).toBeGreaterThan(first.generation);
          yield* server.drain();
        }).pipe(Effect.scoped),
    );
  });
});
