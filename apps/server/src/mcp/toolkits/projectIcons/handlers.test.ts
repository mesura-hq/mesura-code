import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
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

import { ServerConfig, layerTest } from "../../../config.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
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
  it.effect("imports an attachment once and preserves its source", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness;
        const source = h.path.join(h.config.attachmentsDir, "user-logo.svg");
        yield* h.write(source);
        const first = yield* h.invoke(source);
        const second = yield* h.invoke(source);
        expect(first).toEqual(second);
        expect(first).toMatchObject({ imported: true });
        if (!("faviconPath" in first) || typeof first.faviconPath !== "string")
          throw new Error("Expected an imported image path");
        expect(yield* h.fs.readFileString(h.path.join(h.root, first.faviconPath))).toBe(
          yield* h.fs.readFileString(source),
        );
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
