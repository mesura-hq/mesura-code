// Entry point: `ProjectIconsToolkit.handle("set_project_icon")` with the
// production handlers behind their `McpToolAccess` declaration, invoked under
// an `McpInvocationContext` as the MCP HTTP layer provides it. The harness
// runs the real v2 `ProjectService` (planner, store and receipts) and the real
// favicon resolver on an in-memory SQLite database; thread shells and their
// user messages come from a `ThreadManagementService` stand-in, so thread
// attachments are message records as the v2 projection returns them.
//
// Project icons phase 2, acceptance criteria 3 (own project; project, worktree
// or own-thread attachment), 4 (nothing written outside the project), 5 (the
// write names the root it prepared against), 6 (reset needs no Codex and starts
// no search) and 7 (the result explains a repository icon that masks the save).
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { attachmentRelativePath, createAttachmentId } from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as RuntimeLayer from "../../../orchestration-v2/runtimeLayer.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../../../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../../../project/ProjectFaviconResolver.ts";
import { PROJECT_ICON_MAX_BYTES } from "../../../project/ProjectIconCandidates.ts";
import {
  locateProjectIconSource,
  readProjectIconSource,
  writeProjectIconFile,
} from "../../../project/ProjectIconFile.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import * as T3ProjectFileLoader from "../../../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as ProjectIconsHandlers from "./handlers.ts";
import { ProjectIconsToolkit } from "./tools.ts";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>';
const EPOCH = DateTime.makeUnsafe("2026-10-11T00:00:00.000Z");
// `liveThreadShell` runs on the `codex` instance; the caller must match it.
const CALLER_INSTANCE = ProviderInstanceId.make("codex");

const testLayer = RuntimeLayer.layerProjectService.pipe(
  Layer.provideMerge(ProjectEnrichmentService.layer),
  Layer.provideMerge(ProjectFaviconResolver.layer.pipe(Layer.provide(T3ProjectFileLoader.layer))),
  Layer.provideMerge(
    Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
      resolve: () => Effect.succeed(null),
    }),
  ),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "project-icon-tool-" })),
  Layer.provideMerge(ServerSettings.layerTest({})),
  Layer.provideMerge(NodeServices.layer),
);

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(testLayer));

const userMessage = (
  threadId: ThreadId,
  id: string,
  attachments: OrchestrationV2ConversationMessage["attachments"],
) =>
  ({
    id: MessageId.make(id),
    threadId,
    runId: null,
    nodeId: null,
    role: "user",
    text: "Use this as the project icon.",
    attachments,
    streaming: false,
    createdAt: EPOCH,
    updatedAt: EPOCH,
  }) as OrchestrationV2ConversationMessage;

/**
 * One project with two threads. The own thread is the caller; the other one
 * owns attachments the caller must not import. Attachments are recorded on
 * user messages as the v2 projection stores them.
 */
const harness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectService.ProjectService;
  const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "project-icon-tool-" });
  const worktree = path.join(scratch, "worktree");
  const outside = path.join(scratch, "outside");
  for (const directory of ["project", "worktree", "outside"]) {
    yield* fs.makeDirectory(path.join(scratch, directory));
  }
  const projectId = ProjectId.make("icon-project");
  const ownThreadId = ThreadId.make("icon-own-thread");
  const otherThreadId = ThreadId.make("icon-other-thread");
  const created = yield* projects.create({
    commandId: CommandId.make("cmd-icon-project"),
    projectId,
    title: "Icon test",
    workspaceRoot: path.join(scratch, "project"),
  });
  const root = created.workspaceRoot;

  const shells = new Map<ThreadId, OrchestrationV2ThreadShell | null>([
    [ownThreadId, { ...liveThreadShell(ownThreadId), projectId }],
    [otherThreadId, { ...liveThreadShell(otherThreadId), projectId }],
  ]);
  const messages = new Map<ThreadId, Array<OrchestrationV2ConversationMessage>>();
  const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: (threadId) => Effect.sync(() => shells.get(threadId) ?? null),
    getThreadRecords: (threadId, _fields, filter) =>
      Effect.sync(
        () =>
          ({
            thread: shells.get(threadId),
            messages: (messages.get(threadId) ?? []).filter(
              (message) =>
                filter?.messageRoles === undefined || filter.messageRoles.includes(message.role),
            ),
          }) as never,
      ),
  });

  // Runs right after the handler reads the project, before it saves, so a
  // test can change the project in that interval.
  let afterProjectLookup: Effect.Effect<void> = Effect.void;
  const updates: Array<ProjectService.ProjectUpdateInput> = [];
  const observed = ProjectService.ProjectService.of({
    ...projects,
    getShell: (id) => projects.getShell(id).pipe(Effect.tap(() => afterProjectLookup)),
    update: (input) =>
      Effect.suspend(() => {
        updates.push(input);
        return projects.update(input);
      }),
  });
  const dependencies = Layer.merge(threads, Layer.succeed(ProjectService.ProjectService, observed));
  const toolkit = yield* ProjectIconsToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(ProjectIconsHandlers.layer).pipe(
        Layer.provide(dependencies),
      ),
    ),
  );

  const invocation = (
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
    caller: "thread" | "client",
  ): McpInvocationContext.McpInvocationScope => ({
    environmentId: EnvironmentId.make("icon-environment"),
    requestNamespace: "session",
    thread:
      caller === "thread"
        ? {
            threadId: ownThreadId,
            providerSessionId: "session",
            providerInstanceId: CALLER_INSTANCE,
          }
        : undefined,
    client:
      caller === "client"
        ? { sessionId: "client-session", label: "Outside client", access: "full-access" }
        : undefined,
    capabilities: new Set(capabilities),
    issuedAt: 1,
  });
  const invoke = (
    imagePath: string | null,
    options: {
      readonly capabilities?: ReadonlyArray<McpInvocationContext.McpCapability>;
      readonly caller?: "thread" | "client";
    } = {},
  ) =>
    toolkit.handle("set_project_icon", { imagePath }).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunks) => chunks.at(-1)!.result),
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        invocation(options.capabilities ?? ["project-icons"], options.caller ?? "thread"),
      ),
      Effect.provide(dependencies),
    );

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
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, SVG);
      return { attachment, file };
    });
  let messageCount = 0;
  /** Writes an attachment and records it on a user message of `threadId`. */
  const attach = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const { attachment, file } = yield* attachmentFile(threadId);
      messageCount += 1;
      messages.set(threadId, [
        ...(messages.get(threadId) ?? []),
        userMessage(threadId, `msg-icon-${messageCount}`, [attachment]),
      ]);
      return file;
    });

  const project = () =>
    projects.getById(projectId, { includeDeleted: true }).pipe(Effect.map(Option.getOrNull));
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
    projectId,
    ownThreadId,
    otherThreadId,
    updates,
    invoke,
    attach,
    attachmentFile,
    project,
    write,
    tree,
    moveToWorktree: () => {
      const shell = shells.get(ownThreadId);
      if (shell) shells.set(ownThreadId, { ...shell, worktreePath: worktree });
    },
    deleteThread: () => {
      shells.set(ownThreadId, null);
    },
    deleteProjectAfterLookup: () => {
      afterProjectLookup = projects
        .delete({
          commandId: CommandId.make("cmd-icon-delete-during-tool"),
          projectId,
          force: true,
        })
        .pipe(Effect.asVoid, Effect.orDie);
    },
    moveProjectAfterLookup: (workspaceRoot: string) => {
      afterProjectLookup = projects
        .update({
          commandId: CommandId.make("cmd-icon-move-during-tool"),
          projectId,
          workspaceRoot,
        })
        .pipe(Effect.asVoid, Effect.orDie);
    },
  };
});

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
        expect(h.updates).toHaveLength(1);
        expect(h.updates[0]).toMatchObject({
          projectId: "icon-project",
          faviconPath: "logo.svg",
          projectIcon: null,
        });
        expect((yield* h.project())?.faviconPath).toBe("logo.svg");
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
        expect(h.updates[0]).toMatchObject({
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
        expect(yield* h.invoke("logo.svg", { capabilities: [] }).pipe(Effect.flip)).toMatchObject({
          _tag: "McpCapabilityUnavailableError",
        });
        expect(h.updates).toHaveLength(0);
      }),
    ),
  );

  it.effect("project icon tool guard: an outside MCP client cannot set a project icon", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.write(h.path.join(h.root, "logo.svg"));
        expect(
          yield* h.invoke(h.path.join(h.root, "logo.svg"), { caller: "client" }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "OrchestratorMcpFailure", code: "thread_credential_required" });
        expect(h.updates).toHaveLength(0);
      }),
    ),
  );

  it.effect(
    "refuses missing threads, outside paths, and non-images without changing the icon",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* harness;
          yield* h.write(h.path.join(h.outside, "outside.svg"));
          yield* h.write(h.path.join(h.root, "notes.txt"));
          for (const imagePath of [
            h.path.join(h.outside, "outside.svg"),
            "notes.txt",
            "missing.svg",
          ]) {
            expect(yield* h.invoke(imagePath).pipe(Effect.flip)).toMatchObject({
              _tag: "ProjectIconUpdateError",
            });
          }
          // The access gate refuses a caller whose thread is gone.
          h.deleteThread();
          expect(yield* h.invoke(null).pipe(Effect.flip)).toMatchObject({
            _tag: "OrchestratorMcpFailure",
            code: "thread_not_found",
          });
          expect(h.updates).toHaveLength(0);
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
        expect(h.updates).toHaveLength(0);
      }),
    ),
  );

  it.effect("can reset a manual choice to default icon resolution", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness;
        expect(yield* h.invoke(null)).toMatchObject({ faviconPath: null, imported: false });
        expect(h.updates[0]).toMatchObject({ faviconPath: null, projectIcon: null });
      }),
    ),
  );
});

describe("agent project icon tool attachments and files", () => {
  it.effect("project icon tool fence: an attachment on another thread is refused", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness;
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
      run(
        Effect.gen(function* () {
          const h = yield* harness;
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
      run(
        Effect.gen(function* () {
          const h = yield* harness;
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
      run(
        Effect.gen(function* () {
          const h = yield* harness;
          h.moveToWorktree();
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
      run(
        Effect.gen(function* () {
          const h = yield* harness;
          h.moveToWorktree();
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
    run(
      Effect.gen(function* () {
        const h = yield* harness;
        h.moveToWorktree();
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
      run(
        Effect.gen(function* () {
          const h = yield* harness;
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
      run(
        Effect.gen(function* () {
          const h = yield* harness;
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
    run(
      Effect.gen(function* () {
        const h = yield* harness;
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
    run(
      Effect.gen(function* () {
        const h = yield* harness;
        h.deleteProjectAfterLookup();
        expect(yield* h.invoke(null).pipe(Effect.flip)).toMatchObject({
          _tag: "ProjectIconUpdateError",
        });
      }),
    ),
  );

  it.effect("project icon tool rework: a save after the project was deleted fails", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness;
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
      run(
        Effect.gen(function* () {
          const h = yield* harness;
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
      run(
        Effect.gen(function* () {
          const h = yield* harness;
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
      run(
        Effect.gen(function* () {
          const h = yield* harness;
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
      run(
        Effect.gen(function* () {
          const h = yield* harness;
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
      run(
        Effect.gen(function* () {
          const h = yield* harness;
          h.moveToWorktree();
          const movedRoot = h.path.join(h.outside, "moved-project");
          yield* h.fs.makeDirectory(movedRoot);
          // The worktree image is imported into the old root, then the save is refused.
          yield* h.write(h.path.join(h.worktree, "brand.svg"));
          h.moveProjectAfterLookup(movedRoot);
          expect(yield* h.invoke("brand.svg").pipe(Effect.flip)).toMatchObject({
            _tag: "ProjectIconUpdateError",
          });
          const project = yield* h.project();
          expect(project?.workspaceRoot).not.toBe(h.root);
          expect(project?.faviconPath ?? null).toBeNull();
          expect(yield* h.tree(movedRoot)).toEqual([]);
        }),
      ),
  );
});
