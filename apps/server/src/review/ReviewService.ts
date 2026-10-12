import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import {
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type ReviewDiffPreviewError,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  type GitWorkingTreeChangesInput,
  type GitWorkingTreeChangesResult,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { readWorkingTreeChanges } from "./GitWorkingTreeChanges.ts";
import * as GitWorkingTreeWatcher from "./GitWorkingTreeWatcher.ts";
import * as ServerSettings from "../serverSettings.ts";
import { isFilesystemRoot, managedWorktreesDirectories } from "../worktreesDirectory.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

export class ReviewService extends Context.Service<
  ReviewService,
  {
    readonly getDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, ReviewDiffPreviewError>;
    readonly getDiffFileContents: (
      input: ReviewDiffFileContentsInput,
    ) => Effect.Effect<ReviewDiffFileContentsResult, ReviewDiffPreviewError>;
    /** Fork addition: per-file status for the Git status surface. */
    readonly getWorkingTreeChanges: (
      input: GitWorkingTreeChangesInput,
    ) => Effect.Effect<GitWorkingTreeChangesResult, ReviewDiffPreviewError>;
    /** Fork addition: the same, pushed again whenever it changes. */
    readonly subscribeWorkingTreeChanges: (
      input: GitWorkingTreeChangesInput,
    ) => Stream.Stream<GitWorkingTreeChangesResult, ReviewDiffPreviewError>;
  }
>()("t3/review/ReviewService") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const workingTreeWatcher = yield* GitWorkingTreeWatcher.GitWorkingTreeWatcher;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;

  const canonicalizePath = (value: string, allowMissing = true) => {
    const resolvedPath = path.resolve(value);
    return fileSystem.realPath(resolvedPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound" && allowMissing
            ? Effect.succeed(resolvedPath)
            : Effect.fail(
                new VcsRepositoryDetectionError({
                  operation: "ReviewService.assertWorkspaceBoundCwd.canonicalizePath",
                  cwd: resolvedPath,
                  detail: "Failed to resolve a path while validating the review workspace.",
                  cause,
                }),
              ),
      }),
    );
  };

  const isWithinRoot = (candidate: string, root: string) => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  const assertWorkspaceBoundCwd = Effect.fn("ReviewService.assertWorkspaceBoundCwd")(function* (
    operation:
      | "ReviewService.getDiffPreview"
      | "ReviewService.getDiffFileContents"
      | "ReviewService.getWorkingTreeChanges"
      | "ReviewService.subscribeWorkingTreeChanges",
    cwd: string,
  ) {
    const worktreesDirectories = yield* settings.getSettings.pipe(
      Effect.orElseSucceed(() => ({ worktreesDirectory: "", previousWorktreesDirectories: [] })),
    );
    const home = yield* HostProcess.HomeDirectory;
    const [candidate, workspaceRoot, worktreesRoots] = yield* Effect.all([
      canonicalizePath(cwd),
      canonicalizePath(config.cwd),
      // A managed root that cannot be resolved, or resolves to a filesystem
      // root through a symlink, is skipped rather than failing every review.
      Effect.forEach(
        managedWorktreesDirectories(worktreesDirectories, config.worktreesDir, path, home),
        (directory) => canonicalizePath(directory).pipe(Effect.orElseSucceed(() => null)),
      ).pipe(
        Effect.map((roots) =>
          roots.filter((root): root is string => root !== null && !isFilesystemRoot(root, path)),
        ),
      ),
    ]);

    if (
      isWithinRoot(candidate, workspaceRoot) ||
      worktreesRoots.some((root) => isWithinRoot(candidate, root))
    ) {
      return;
    }

    // Registered projects can live outside the server cwd. Unreadable or
    // unresolvable project roots grant nothing, including missing roots.
    const projects = yield* projectStore.listShells().pipe(Effect.orElseSucceed(() => []));
    for (const project of projects) {
      const root = yield* canonicalizePath(project.workspaceRoot, false).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (root !== null && isWithinRoot(candidate, root)) {
        return;
      }
    }

    return yield* new VcsRepositoryDetectionError({
      operation,
      cwd,
      detail:
        operation === "ReviewService.getDiffPreview"
          ? "Review diff preview cwd must stay within the configured workspace root."
          : operation === "ReviewService.getWorkingTreeChanges" ||
              operation === "ReviewService.subscribeWorkingTreeChanges"
            ? "Working tree changes cwd must stay within the configured workspace root."
            : "Review diff file contents cwd must stay within the configured workspace root.",
    });
  });

  const getDiffPreview: ReviewService["Service"]["getDiffPreview"] = Effect.fn(
    "ReviewService.getDiffPreview",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffPreview", input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (!handle) {
      return {
        cwd: input.cwd,
        generatedAt: yield* DateTime.now,
        sources: [],
      };
    }

    const getDriverDiffPreview = handle.driver.getDiffPreview;
    if (!getDriverDiffPreview) {
      if (handle.kind === "git") {
        return yield* git.getReviewDiffPreview(input);
      }
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffPreview",
        kind: handle.kind,
        detail: `The ${handle.kind} VCS driver does not support review diff previews.`,
      });
    }

    return yield* getDriverDiffPreview(input);
  });

  const getDiffFileContents: ReviewService["Service"]["getDiffFileContents"] = Effect.fn(
    "ReviewService.getDiffFileContents",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffFileContents", input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (handle?.kind !== "git") {
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffFileContents",
        kind: handle?.kind ?? "unknown",
        detail: "Unchanged diff expansion currently requires a Git repository.",
      });
    }

    return yield* git.getReviewDiffFileContents(input);
  });

  const getWorkingTreeChanges: ReviewService["Service"]["getWorkingTreeChanges"] = Effect.fn(
    "ReviewService.getWorkingTreeChanges",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getWorkingTreeChanges", input.cwd);
    return yield* readWorkingTreeChanges({ git, fileSystem, path }, input.cwd);
  });

  const subscribeWorkingTreeChanges: ReviewService["Service"]["subscribeWorkingTreeChanges"] = (
    input,
  ) =>
    Stream.unwrap(
      assertWorkspaceBoundCwd("ReviewService.subscribeWorkingTreeChanges", input.cwd).pipe(
        Effect.as(workingTreeWatcher.watch(input.cwd)),
      ),
    );

  return ReviewService.of({
    getDiffPreview,
    getDiffFileContents,
    getWorkingTreeChanges,
    subscribeWorkingTreeChanges,
  });
});

// Fork: the working-tree watcher is built here rather than in `server.ts`, so
// the watcher adds no requirement for upstream's callers of this layer. Layers
// are memoized by reference, so a caller that also provides
// `GitWorkingTreeWatcher.layer` shares this one instance.
export const layer = Layer.effect(ReviewService, make).pipe(
  Layer.provide(GitWorkingTreeWatcher.layer),
);
