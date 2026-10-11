// Entry point: `ProjectIconsToolkit.handle("set_project_icon")` with the
// production handlers, invoked under an `McpInvocationContext` as the MCP HTTP
// layer provides it. The first harness mocks the snapshot query and engine to
// observe dispatched commands; the second runs the real orchestration engine,
// projection pipeline and snapshot query on an in-memory SQLite database, so
// thread attachments are the persisted message records.
//
// Project icons phase 2, acceptance criteria 3 (own project; project, worktree
// or own-thread attachment), 4 (nothing written outside the project), 5 (the
// write names the root it prepared against), 6 (reset needs no Codex and starts
// no search) and 7 (the result explains a repository icon that masks the save).
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { attachmentRelativePath, createAttachmentId } from "../../../attachmentStore.ts";
import { ServerConfig, layerTest } from "../../../config.ts";
import { OrchestrationLayerLive } from "../../../orchestration/runtimeLayer.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as ProjectFaviconResolver from "../../../project/ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import * as T3ProjectFileLoader from "../../../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  locateProjectIconSource,
  readProjectIconSource,
  writeProjectIconFile,
} from "../../../project/ProjectIconFile.ts";
import { PROJECT_ICON_MAX_BYTES } from "../../../project/ProjectIconCandidates.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ProjectIconsToolkitHandlersLive } from "./handlers.ts";
import { ProjectIconsToolkit } from "./tools.ts";

const harness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const root = yield* fs.makeTempDirectoryScoped();
  const worktree = yield* fs.makeTempDirectoryScoped();
  const threadId = ThreadId.make("icon-thread");
  const projectId = ProjectId.make("icon-project");
  const commands: OrchestrationCommand[] = [];
  const project: OrchestrationProjectShell = {
    id: projectId,
    title: "Icon test",
    workspaceRoot: root,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-09T00:00:00.000Z",
    updatedAt: "2026-10-09T00:00:00.000Z",
  };
  let thread: OrchestrationThreadShell | null = {
    id: threadId,
    projectId,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-luna" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (id) =>
        Effect.sync(() => (id === threadId ? Option.fromNullishOr(thread) : Option.none())),
      getProjectShellById: (id) =>
        Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
    }),
    Layer.succeed(ServerConfig, config),
    ProjectFaviconResolver.layer.pipe(
      Layer.provide(WorkspacePaths.layer),
      Layer.provide(T3ProjectFileLoader.layer),
    ),
  );
  const toolkit = yield* ProjectIconsToolkit.pipe(
    Effect.provide(ProjectIconsToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const invoke = (imagePath: string | null, granted = true) =>
    toolkit.handle("set_project_icon", { imagePath }).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunks) => chunks.at(-1)!.result),
      Effect.provideService(McpInvocationContext, {
        environmentId: EnvironmentId.make("icon-environment"),
        threadId,
        providerSessionId: "session",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(granted ? ["project-icons" as const] : []),
        issuedAt: 1,
      }),
      Effect.provide(dependencies),
    );
  const write = (absolute: string, contents = '<svg xmlns="http://www.w3.org/2000/svg"/>') =>
    fs.writeFileString(absolute, contents);
  return {
    fs,
    path,
    root,
    worktree,
    config,
    commands,
    invoke,
    write,
    moveToWorktree: () => {
      if (thread) thread = { ...thread, worktreePath: worktree };
    },
    deleteThread: () => {
      thread = null;
    },
  };
});

const testLayer = layerTest(process.cwd(), { prefix: "project-icon-tool-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(testLayer));

describe("agent project icon tool", () => {
  it.effect("sets only this thread's project and stores a relative path", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.write(h.path.join(h.root, "logo.svg"));
        const result = yield* h.invoke("logo.svg");
        expect(result).toMatchObject({
          projectId: "icon-project",
          faviconPath: "logo.svg",
          imported: false,
        });
        expect(h.commands).toHaveLength(1);
        expect(h.commands[0]).toMatchObject({
          type: "project.meta.update",
          projectId: "icon-project",
          faviconPath: "logo.svg",
          projectIcon: null,
        });
      }),
    ),
  );
  it.effect("imports an image from the thread's worktree into the project", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness;
        h.moveToWorktree();
        yield* h.write(h.path.join(h.worktree, "brand.svg"));
        expect(yield* h.invoke("brand.svg")).toMatchObject({ imported: true });
      }),
    ),
  );
  it.effect("project icon tool fence: an image write names the root it was prepared in", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.write(h.path.join(h.root, "logo.svg"));
        yield* h.invoke("logo.svg");
        expect(h.commands[0]).toMatchObject({
          type: "project.meta.update",
          faviconPath: "logo.svg",
          expectedWorkspaceRoot: h.root,
        });
      }),
    ),
  );
  it.effect("rejects a credential without the project-icons capability", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness;
        expect(yield* h.invoke("logo.svg", false).pipe(Effect.flip)).toMatchObject({
          _tag: "McpCapabilityUnavailableError",
        });
        expect(h.commands).toHaveLength(0);
      }),
    ),
  );
  it.effect(
    "refuses missing threads, outside paths, and non-images without changing the icon",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* harness;
          const outside = yield* h.fs.makeTempDirectoryScoped();
          yield* h.write(h.path.join(outside, "outside.svg"));
          yield* h.write(h.path.join(h.root, "notes.txt"));
          for (const imagePath of [
            h.path.join(outside, "outside.svg"),
            "notes.txt",
            "missing.svg",
          ]) {
            expect(yield* h.invoke(imagePath).pipe(Effect.flip)).toMatchObject({
              _tag: "ProjectIconUpdateError",
            });
          }
          h.deleteThread();
          expect(yield* h.invoke(null).pipe(Effect.flip)).toMatchObject({
            _tag: "ProjectIconUpdateError",
          });
          expect(h.commands).toHaveLength(0);
        }),
      ),
  );
  it.effect("refuses oversized images and directories", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.write(h.path.join(h.root, "large.svg"), "x".repeat(2 * 1024 * 1024 + 1));
        yield* h.fs.makeDirectory(h.path.join(h.root, "folder.png"));
        for (const imagePath of ["large.svg", "folder.png"]) {
          expect(yield* h.invoke(imagePath).pipe(Effect.flip)).toMatchObject({
            _tag: "ProjectIconUpdateError",
          });
        }
        expect(h.commands).toHaveLength(0);
      }),
    ),
  );
  it.effect("can reset a manual choice to default icon resolution", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness;
        expect(yield* h.invoke(null)).toMatchObject({ faviconPath: null, imported: false });
        expect(h.commands[0]).toMatchObject({ faviconPath: null, projectIcon: null });
      }),
    ),
  );
});

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>';
const realLayer = Layer.mergeAll(
  OrchestrationLayerLive,
  ProjectFaviconResolver.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(T3ProjectFileLoader.layer),
  ),
).pipe(
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provideMerge(layerTest(process.cwd(), { prefix: "project-icon-tool-real-" })),
  Layer.provideMerge(NodeServices.layer),
);

/**
 * A project with two threads on the real engine. The own thread runs in a
 * worktree; attachments are recorded on user messages as `thread.turn.start`
 * persists them.
 */
const realHarness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "project-icon-tool-real-" });
  const root = path.join(scratch, "project");
  const worktree = path.join(scratch, "worktree");
  const outside = path.join(scratch, "outside");
  for (const directory of [root, worktree, outside]) yield* fs.makeDirectory(directory);
  const projectId = ProjectId.make("icon-real-project");
  const ownThreadId = ThreadId.make("icon-own-thread");
  const otherThreadId = ThreadId.make("icon-other-thread");
  const now = "2026-10-11T00:00:00.000Z";
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("cmd-icon-real-project"),
    projectId,
    title: "Icon real",
    workspaceRoot: root,
    createdAt: now,
  });
  for (const [threadId, worktreePath] of [
    [ownThreadId, worktree],
    [otherThreadId, null],
  ] as const) {
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-create-${threadId}`),
      threadId,
      projectId,
      title: threadId,
      modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" },
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath,
      createdAt: now,
    });
  }
  const attachmentFile = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const attachment = {
        type: "image" as const,
        id: createAttachmentId(threadId, "svg")!,
        name: "user-logo.svg",
        mimeType: "image/svg+xml",
        sizeBytes: SVG.length,
      };
      const file = path.join(config.attachmentsDir, attachmentRelativePath(attachment)!);
      yield* fs.writeFileString(file, SVG);
      return { attachment, file };
    });
  let messages = 0;
  /** Writes an attachment and records it on a user message of `threadId`. */
  const attach = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const { attachment, file } = yield* attachmentFile(threadId);
      messages += 1;
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`cmd-icon-turn-${messages}`),
        threadId,
        message: {
          messageId: MessageId.make(`msg-icon-${messages}`),
          role: "user",
          text: "Use this as the project icon.",
          attachments: [attachment],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      });
      return file;
    });
  // Runs right after the handler reads the project, before it dispatches, so
  // a test can change the project in that interval.
  let afterProjectLookup: Effect.Effect<void> = Effect.void;
  const observedSnapshots = ProjectionSnapshotQuery.of({
    ...snapshots,
    getProjectShellById: (id) =>
      snapshots.getProjectShellById(id).pipe(Effect.tap(() => afterProjectLookup)),
  });
  const toolkit = yield* ProjectIconsToolkit.pipe(
    Effect.provide(ProjectIconsToolkitHandlersLive),
    Effect.provideService(ProjectionSnapshotQuery, observedSnapshots),
  );
  const invoke = (imagePath: string | null) =>
    toolkit.handle("set_project_icon", { imagePath }).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunks) => chunks.at(-1)!.result),
      Effect.provideService(McpInvocationContext, {
        environmentId: EnvironmentId.make("icon-environment"),
        threadId: ownThreadId,
        providerSessionId: "session",
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        capabilities: new Set(["project-icons" as const]),
        issuedAt: 1,
      }),
    );
  const project = () => snapshots.getProjectShellById(projectId).pipe(Effect.map(Option.getOrNull));
  const write = (absolute: string, contents = SVG) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(absolute), { recursive: true });
      yield* fs.writeFileString(absolute, contents);
    });
  /** Every path below `directory`, so a test can show nothing was created there. */
  const tree = (directory: string) => fs.readDirectory(directory, { recursive: true });
  return {
    fs,
    path,
    root,
    worktree,
    outside,
    ownThreadId,
    otherThreadId,
    attach,
    attachmentFile,
    invoke,
    project,
    write,
    tree,
    projectId,
    deleteProjectAfterLookup: () => {
      afterProjectLookup = engine
        .dispatch({
          type: "project.delete",
          commandId: CommandId.make("cmd-icon-real-delete-during-tool"),
          projectId,
          force: true,
        })
        .pipe(Effect.asVoid, Effect.orDie);
    },
    moveProjectAfterLookup: (workspaceRoot: string) => {
      afterProjectLookup = engine
        .dispatch({
          type: "project.meta.update",
          commandId: CommandId.make("cmd-icon-real-move-during-tool"),
          projectId,
          workspaceRoot,
        })
        .pipe(Effect.asVoid, Effect.orDie);
    },
  };
});

const runReal = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(realLayer));

describe("agent project icon tool on the real engine", () => {
  it.effect("project icon tool fence: an attachment on another thread is refused", () =>
    runReal(
      Effect.gen(function* () {
        const h = yield* realHarness;
        const foreign = yield* h.attach(h.otherThreadId);
        expect(yield* h.invoke(foreign).pipe(Effect.flip)).toMatchObject({
          _tag: "ProjectIconUpdateError",
        });
        expect((yield* h.project())?.faviconPath ?? null).toBeNull();
        expect(yield* h.tree(h.root)).toEqual([]);
      }),
    ),
  );

  it.effect(
    "project icon tool fence: an attachment file recorded on no message of this thread is refused",
    () =>
      runReal(
        Effect.gen(function* () {
          const h = yield* realHarness;
          // Named for this thread and sitting in the shared directory, but never
          // attached to one of its messages.
          const { file } = yield* h.attachmentFile(h.ownThreadId);
          expect(yield* h.invoke(file).pipe(Effect.flip)).toMatchObject({
            _tag: "ProjectIconUpdateError",
          });
          expect((yield* h.project())?.faviconPath ?? null).toBeNull();
          expect(yield* h.tree(h.root)).toEqual([]);
        }),
      ),
  );

  it.effect(
    "project icon tool guard: this thread's attachment imports once and keeps its source",
    () =>
      runReal(
        Effect.gen(function* () {
          const h = yield* realHarness;
          const source = yield* h.attach(h.ownThreadId);
          type Saved = { readonly faviconPath: string | null };
          const first = (yield* h.invoke(source)) as Saved;
          const second = (yield* h.invoke(source)) as Saved;
          expect(first).toMatchObject({ imported: true });
          expect(second).toMatchObject({ imported: true, faviconPath: first.faviconPath });
          expect(first.faviconPath).toMatch(/^\.mesura\/project-icons\/[0-9a-f]{64}\.svg$/);
          expect(yield* h.tree(h.path.join(h.root, ".mesura", "project-icons"))).toHaveLength(1);
          expect(yield* h.fs.readFileString(source)).toBe(SVG);
          expect((yield* h.project())?.faviconPath).toBe(first.faviconPath);
        }),
      ),
  );

  it.effect(
    "project icon tool fence: a .mesura symlink out of the project creates nothing outside",
    () =>
      runReal(
        Effect.gen(function* () {
          const h = yield* realHarness;
          yield* h.fs.symlink(h.outside, h.path.join(h.root, ".mesura"));
          yield* h.write(h.path.join(h.worktree, "brand.svg"));
          expect(yield* h.invoke("brand.svg").pipe(Effect.flip)).toMatchObject({
            _tag: "ProjectIconUpdateError",
          });
          expect(yield* h.tree(h.outside), "no directory may appear outside the project").toEqual(
            [],
          );
          expect((yield* h.project())?.faviconPath ?? null).toBeNull();
        }),
      ),
  );

  it.effect(
    "project icon tool guard: a project-icons symlink out of the project writes nothing outside",
    () =>
      runReal(
        Effect.gen(function* () {
          const h = yield* realHarness;
          yield* h.fs.makeDirectory(h.path.join(h.root, ".mesura"));
          yield* h.fs.symlink(h.outside, h.path.join(h.root, ".mesura", "project-icons"));
          yield* h.write(h.path.join(h.worktree, "brand.svg"));
          expect(yield* h.invoke("brand.svg").pipe(Effect.flip)).toMatchObject({
            _tag: "ProjectIconUpdateError",
          });
          expect(yield* h.tree(h.outside)).toEqual([]);
          expect((yield* h.project())?.faviconPath ?? null).toBeNull();
        }),
      ),
  );

  it.effect("project icon tool guard: a worktree image linked to a file outside is refused", () =>
    runReal(
      Effect.gen(function* () {
        const h = yield* realHarness;
        yield* h.write(h.path.join(h.outside, "secret.svg"));
        yield* h.fs.symlink(
          h.path.join(h.outside, "secret.svg"),
          h.path.join(h.worktree, "brand.svg"),
        );
        expect(yield* h.invoke("brand.svg").pipe(Effect.flip)).toMatchObject({
          _tag: "ProjectIconUpdateError",
        });
        expect(yield* h.tree(h.root)).toEqual([]);
      }),
    ),
  );

  it.effect(
    "project icon tool guard: reset works with no Codex instance and starts no search",
    () =>
      runReal(
        Effect.gen(function* () {
          const h = yield* realHarness;
          yield* h.write(h.path.join(h.root, "logo.svg"));
          yield* h.invoke(h.path.join(h.root, "logo.svg"));
          expect(yield* h.invoke(null)).toMatchObject({ faviconPath: null, imported: false });
          const project = yield* h.project();
          expect(project?.faviconPath ?? null).toBeNull();
          expect(["pending", "running"]).not.toContain(project?.iconDiscovery?.status);
        }),
      ),
  );

  it.effect(
    "project icon tool fence: the result says when a repository icon masks the saved image",
    () =>
      runReal(
        Effect.gen(function* () {
          const h = yield* realHarness;
          yield* h.write(
            h.path.join(h.root, ".mesura.json"),
            '{ "version": 1, "iconPath": "brand/portable.svg" }',
          );
          yield* h.write(h.path.join(h.root, "brand", "portable.svg"));
          yield* h.write(h.path.join(h.root, "logo.svg"));
          const result = yield* h.invoke(h.path.join(h.root, "logo.svg"));
          expect(result).toMatchObject({ faviconPath: "logo.svg", effectiveSource: "mesura" });
          const message = (result as { message?: string }).message ?? "";
          expect(message).toMatch(/saved/i);
          expect(message).toContain(".mesura.json");
          expect((yield* h.project())?.faviconPath).toBe("logo.svg");
        }),
      ),
  );

  it.effect("project icon tool fence: the result says when the saved image displays", () =>
    runReal(
      Effect.gen(function* () {
        const h = yield* realHarness;
        yield* h.write(h.path.join(h.root, "logo.svg"));
        const result = yield* h.invoke(h.path.join(h.root, "logo.svg"));
        expect(result).toMatchObject({ faviconPath: "logo.svg", effectiveSource: "project" });
        const message = (result as { message?: string }).message ?? "";
        expect(message).toMatch(/saved/i);
        expect(message).not.toContain(".mesura.json");
      }),
    ),
  );
});

// Rework of the phase 2 review: a source or ancestor that changes after it was
// checked, a deletion between the lookup and the save, and bounded reads.
describe("project icon import races", () => {
  it.effect("project icon tool rework: a reset after the project was deleted fails", () =>
    runReal(
      Effect.gen(function* () {
        const h = yield* realHarness;
        h.deleteProjectAfterLookup();
        expect(yield* h.invoke(null).pipe(Effect.flip)).toMatchObject({
          _tag: "ProjectIconUpdateError",
        });
      }),
    ),
  );

  it.effect("project icon tool rework: a save after the project was deleted fails", () =>
    runReal(
      Effect.gen(function* () {
        const h = yield* realHarness;
        yield* h.write(h.path.join(h.root, "logo.svg"));
        h.deleteProjectAfterLookup();
        expect(yield* h.invoke(h.path.join(h.root, "logo.svg")).pipe(Effect.flip)).toMatchObject({
          _tag: "ProjectIconUpdateError",
        });
      }),
    ),
  );

  it.effect(
    "project icon tool rework: a source swapped for an outside link after it was located is not read",
    () =>
      runReal(
        Effect.gen(function* () {
          const h = yield* realHarness;
          const source = h.path.join(h.worktree, "brand.svg");
          yield* h.write(source);
          const located = yield* Effect.promise(() =>
            locateProjectIconSource({
              workspaceRoot: h.root,
              workingDirectory: h.worktree,
              attachmentsDirectory: h.outside,
              imagePath: "brand.svg",
            }),
          );
          expect(located.kind).toBe("worktree");
          if (located.kind !== "worktree") return;
          // Both an outside image and an outside non-image are refused.
          for (const outsideName of ["secret.svg", "secret.txt"]) {
            yield* h.write(h.path.join(h.outside, outsideName), "OUTSIDE PRIVATE BYTES");
            yield* h.fs.remove(source);
            yield* h.fs.symlink(h.path.join(h.outside, outsideName), source);
            expect(yield* readProjectIconSource(located).pipe(Effect.flip)).toMatchObject({
              _tag: "ProjectIconFileError",
            });
          }
          expect(yield* h.tree(h.root)).toEqual([]);
        }),
      ),
  );

  it.effect(
    "project icon tool rework: a source grown past 2 MiB after it was located is not imported",
    () =>
      runReal(
        Effect.gen(function* () {
          const h = yield* realHarness;
          const source = h.path.join(h.worktree, "brand.svg");
          yield* h.write(source);
          const located = yield* Effect.promise(() =>
            locateProjectIconSource({
              workspaceRoot: h.root,
              workingDirectory: h.worktree,
              attachmentsDirectory: h.outside,
              imagePath: "brand.svg",
            }),
          );
          if (located.kind !== "worktree") throw new Error("Expected a worktree image");
          yield* h.write(source, "x".repeat(PROJECT_ICON_MAX_BYTES + 1));
          expect(yield* readProjectIconSource(located).pipe(Effect.flip)).toMatchObject({
            _tag: "ProjectIconFileError",
          });
          expect(yield* h.tree(h.root)).toEqual([]);
        }),
      ),
  );

  it.effect(
    "project icon tool rework: an import directory swapped for an outside link writes nothing outside",
    () =>
      runReal(
        Effect.gen(function* () {
          const h = yield* realHarness;
          const bytes = Buffer.from(SVG);
          // An earlier import left real directories behind.
          yield* Effect.promise(() =>
            writeProjectIconFile({ workspaceRoot: h.root, bytes, extension: ".svg" }),
          );
          const icons = h.path.join(h.root, ".mesura", "project-icons");
          for (const linked of [icons, h.path.join(h.root, ".mesura")]) {
            yield* h.fs.remove(linked, { recursive: true });
            yield* h.fs.symlink(h.outside, linked);
            const failure = yield* Effect.promise(() =>
              writeProjectIconFile({
                workspaceRoot: h.root,
                bytes: Buffer.from(`${SVG}<!-- ${linked} -->`),
                extension: ".svg",
              }).then(
                () => null,
                (error: unknown) => error,
              ),
            );
            expect(failure).toBeInstanceOf(Error);
            expect(yield* h.tree(h.outside), "no file may appear outside the project").toEqual([]);
          }
        }),
      ),
  );

  it.effect(
    "project icon tool rework: a different file under the content name is refused with a bounded read",
    () =>
      runReal(
        Effect.gen(function* () {
          const h = yield* realHarness;
          const bytes = Buffer.from(SVG);
          const saved = yield* Effect.promise(() =>
            writeProjectIconFile({ workspaceRoot: h.root, bytes, extension: ".svg" }),
          );
          // The repeat reuses the same file.
          expect(
            yield* Effect.promise(() =>
              writeProjectIconFile({ workspaceRoot: h.root, bytes, extension: ".svg" }),
            ),
          ).toBe(saved);
          yield* h.write(h.path.join(h.root, saved), "x".repeat(PROJECT_ICON_MAX_BYTES * 4));
          const failure = yield* Effect.promise(() =>
            writeProjectIconFile({ workspaceRoot: h.root, bytes, extension: ".svg" }).then(
              () => null,
              (error: unknown) => error,
            ),
          );
          expect(String(failure)).toContain(
            "A different file already uses this project icon name.",
          );
        }),
      ),
  );
});

describe("project icon tool regression", () => {
  it.effect(
    "project icon tool regression: a project moved while its image was prepared keeps its old icon",
    () =>
      runReal(
        Effect.gen(function* () {
          const h = yield* realHarness;
          const movedRoot = h.path.join(h.outside, "moved-project");
          yield* h.fs.makeDirectory(movedRoot);
          // The worktree image is imported into the old root, then the save is refused.
          yield* h.write(h.path.join(h.worktree, "brand.svg"));
          h.moveProjectAfterLookup(movedRoot);
          expect(yield* h.invoke("brand.svg").pipe(Effect.flip)).toMatchObject({
            _tag: "ProjectIconUpdateError",
          });
          const project = yield* h.project();
          expect(project?.workspaceRoot).toBe(movedRoot);
          expect(project?.faviconPath ?? null).toBeNull();
          expect(yield* h.tree(movedRoot)).toEqual([]);
        }),
      ),
  );
});
