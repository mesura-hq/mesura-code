import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";
import { ProjectId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ReviewService from "./ReviewService.ts";

function layer(input: {
  readonly workspaceRoot: string;
  readonly baseDir: string;
  readonly detectCalls?: Array<{ readonly cwd: string }>;
  readonly worktreesDirectory?: string;
  readonly previousWorktreesDirectories?: ReadonlyArray<string>;
  readonly projectRoots?: ReadonlyArray<string> | "unavailable";
  readonly gitRepositoryRoot?: string;
  readonly gitCalls?: Array<{ readonly cwd: string; readonly operation: string }>;
}) {
  const projectRoots = input.projectRoots ?? [];
  return ReviewService.layer.pipe(
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        listShells: () =>
          projectRoots === "unavailable"
            ? Effect.fail(
                new ProjectStore.ProjectStoreV2Error({ operation: "list", cause: "offline" }),
              )
            : Effect.succeed(
                projectRoots.map((workspaceRoot, index) => ({
                  id: ProjectId.make(`review-project-${index}`),
                  title: `Project ${index}`,
                  workspaceRoot,
                  repositoryIdentity: null,
                  defaultModelSelection: null,
                  defaultThreadEnvMode: null,
                  autoPull: false,
                  faviconPath: null,
                  projectIcon: null,
                  scripts: [],
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                  iconDiscovery: null,
                })),
              ),
      }),
    ),
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        get: () => Effect.die("unexpected VCS registry get"),
        resolve: () => Effect.die("unexpected VCS registry resolve"),
        detect: (request) =>
          Effect.sync(() => {
            input.detectCalls?.push({ cwd: request.cwd });
            return null;
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        execute: (request) =>
          Effect.sync(() => {
            if (input.gitRepositoryRoot === undefined) throw new Error("Unexpected Git read");
            input.gitCalls?.push({ cwd: request.cwd, operation: request.operation });
            return {
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout:
                request.operation === "GitWorkingTreeChanges.root"
                  ? `${input.gitRepositoryRoot}\n`
                  : request.operation === "GitWorkingTreeChanges.status"
                    ? "# branch.head main\0? owned.txt\0"
                    : "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }),
      }),
    ),
    Layer.provide(
      ServerSettings.ServerSettingsService.layerTest({
        worktreesDirectory: input.worktreesDirectory ?? "",
        previousWorktreesDirectories: [...(input.previousWorktreesDirectories ?? [])],
      }),
    ),
    Layer.provide(ServerConfig.layerTest(input.workspaceRoot, input.baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
}

const externalProjectFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fixtureRoot = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-review-project-" });
  const workspaceRoot = path.join(fixtureRoot, "server");
  const baseDir = path.join(fixtureRoot, "base");
  const projectRoot = path.join(fixtureRoot, "project");
  const projectChild = path.join(projectRoot, "packages", "app");
  const sibling = path.join(fixtureRoot, "project-sibling");
  for (const directory of [workspaceRoot, baseDir, projectChild, sibling]) {
    yield* fs.makeDirectory(directory, { recursive: true });
  }
  yield* fs.writeFileString(path.join(projectRoot, "owned.txt"), "one\ntwo\n");
  return { fs, path, fixtureRoot, workspaceRoot, baseDir, projectRoot, projectChild, sibling };
});

describe("ReviewService", () => {
  it.effect.each(["root", "descendant"] as const)(
    "registered project review authorizes external %s previews",
    (location) =>
      Effect.gen(function* () {
        const fixture = yield* externalProjectFixture;
        const cwd = location === "root" ? fixture.projectRoot : fixture.projectChild;
        const detectCalls: Array<{ readonly cwd: string }> = [];
        const result = yield* Effect.gen(function* () {
          const review = yield* ReviewService.ReviewService;
          return yield* review.getDiffPreview({ cwd });
        }).pipe(
          Effect.provide(layer({ ...fixture, projectRoots: [fixture.projectRoot], detectCalls })),
        );
        assert.strictEqual(result.cwd, cwd);
        assert.deepStrictEqual(result.sources, []);
        assert.deepStrictEqual(detectCalls, [{ cwd }]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["root", "descendant"] as const)(
    "registered project review reads and streams external %s working-tree rows",
    (location) =>
      Effect.gen(function* () {
        const fixture = yield* externalProjectFixture;
        const cwd = location === "root" ? fixture.projectRoot : fixture.projectChild;
        const gitCalls: Array<{ readonly cwd: string; readonly operation: string }> = [];
        yield* Effect.gen(function* () {
          const review = yield* ReviewService.ReviewService;
          const result = yield* review.getWorkingTreeChanges({ cwd });
          assert.strictEqual(result.isRepo, true);
          assert.strictEqual(result.repositoryRoot, fixture.projectRoot);
          assert.strictEqual(result.files[0]?.path, "owned.txt");
          assert.strictEqual(result.files[0]?.unstaged.insertions, 2);
          const streamed = yield* Stream.runHead(review.subscribeWorkingTreeChanges({ cwd }));
          assert.deepStrictEqual(Option.getOrThrow(streamed), result);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            layer({
              ...fixture,
              projectRoots: [fixture.projectRoot],
              gitRepositoryRoot: fixture.projectRoot,
              gitCalls,
            }),
          ),
        );
        assert.isTrue(gitCalls.length > 0);
        assert.isTrue(gitCalls.every((call) => call.cwd === cwd));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("registered project review canonicalizes a registered symlink root", () =>
    Effect.gen(function* () {
      const fixture = yield* externalProjectFixture;
      const alias = fixture.path.join(fixture.fixtureRoot, "project-alias");
      yield* fixture.fs.symlink(fixture.projectRoot, alias);
      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: fixture.projectChild });
      }).pipe(Effect.provide(layer({ ...fixture, projectRoots: [alias] })));
      assert.strictEqual(result.cwd, fixture.projectChild);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    "sibling",
    "unregistered",
    "unavailable-store",
    "invalid-root",
    "missing-root",
    "symlink-escape",
  ] as const)("registered project review denies %s across every public read", (scenario) =>
    Effect.gen(function* () {
      const fixture = yield* externalProjectFixture;
      let cwd = fixture.projectRoot;
      let projectRoots: ReadonlyArray<string> | "unavailable" = [fixture.projectRoot];
      if (scenario === "sibling") cwd = fixture.sibling;
      if (scenario === "unregistered") projectRoots = [];
      if (scenario === "unavailable-store") projectRoots = "unavailable";
      if (scenario === "invalid-root") projectRoots = [`${fixture.projectRoot}\0invalid`];
      if (scenario === "missing-root") {
        const missingRoot = fixture.path.join(fixture.fixtureRoot, "missing-project");
        projectRoots = [missingRoot];
        cwd = fixture.path.join(missingRoot, "child");
      }
      if (scenario === "symlink-escape") {
        cwd = fixture.path.join(fixture.projectRoot, "escape");
        yield* fixture.fs.symlink(fixture.sibling, cwd);
      }
      const detectCalls: Array<{ readonly cwd: string }> = [];
      const gitCalls: Array<{ readonly cwd: string; readonly operation: string }> = [];
      yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        // These assertions inspect only failures. A heterogeneous success tuple
        // breaks Effect.flip inference, so normalize unused successful values.
        const attempts = [
          ["ReviewService.getDiffPreview", review.getDiffPreview({ cwd }).pipe(Effect.asVoid)],
          [
            "ReviewService.getDiffFileContents",
            review
              .getDiffFileContents({
                cwd,
                sourceKind: "working-tree",
                changeType: "change",
                baseRef: "HEAD",
                headRef: null,
                oldPath: "owned.txt",
                newPath: "owned.txt",
              })
              .pipe(Effect.asVoid),
          ],
          [
            "ReviewService.getWorkingTreeChanges",
            review.getWorkingTreeChanges({ cwd }).pipe(Effect.asVoid),
          ],
          [
            "ReviewService.subscribeWorkingTreeChanges",
            Stream.runHead(review.subscribeWorkingTreeChanges({ cwd })).pipe(Effect.asVoid),
          ],
        ] as const;
        for (const [operation, attempt] of attempts) {
          const error = yield* attempt.pipe(Effect.flip);
          assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
          if (error._tag !== "VcsRepositoryDetectionError") {
            assert.fail("Expected the workspace denial error before checking its cwd.");
          }
          assert.strictEqual(error.operation, operation);
          assert.strictEqual(error.cwd, cwd);
        }
      }).pipe(Effect.provide(layer({ ...fixture, projectRoots, detectCalls, gitCalls })));
      assert.deepStrictEqual(detectCalls, []);
      assert.deepStrictEqual(gitCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "registered project review retains configured-root access when the store is unavailable",
    () =>
      Effect.gen(function* () {
        const fixture = yield* externalProjectFixture;
        const result = yield* Effect.gen(function* () {
          const review = yield* ReviewService.ReviewService;
          return yield* review.getDiffPreview({ cwd: fixture.workspaceRoot });
        }).pipe(Effect.provide(layer({ ...fixture, projectRoots: "unavailable" })));
        assert.strictEqual(result.cwd, fixture.workspaceRoot);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects diff preview cwd outside the configured workspace roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getDiffPreview");
      assert.match(
        "detail" in error ? error.detail : "",
        /must stay within the configured workspace root/,
      );
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("attributes file-content workspace violations to the file-content operation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review
          .getDiffFileContents({
            cwd: outsideRoot,
            sourceKind: "working-tree",
            changeType: "change",
            baseRef: "HEAD",
            headRef: null,
            oldPath: "file.ts",
            newPath: "file.ts",
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getDiffFileContents");
      assert.match(
        "detail" in error ? error.detail : "",
        /must stay within the configured workspace root/,
      );
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows previous custom worktree locations but never a filesystem root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const previous = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-old-worktrees-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: previous });
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            baseDir,
            worktreesDirectory: "/",
            previousWorktreesDirectories: [previous],
          }),
        ),
      );
      assert.strictEqual(result.cwd, previous);

      const rootLink = `${baseDir}/root-link`;
      yield* fs.symlink("/", rootLink);
      for (const worktreesDirectory of ["/", rootLink]) {
        const error = yield* Effect.gen(function* () {
          const review = yield* ReviewService.ReviewService;
          return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
        }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, worktreesDirectory })));
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows diff preview cwd inside the configured workspace root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: workspaceRoot });
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(result.cwd, workspaceRoot);
      assert.deepStrictEqual(result.sources, []);
      assert.deepStrictEqual(detectCalls, [{ cwd: workspaceRoot }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves unexpected path-resolution failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const invalidCwd = `${workspaceRoot}\0invalid`;
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: invalidCwd }).pipe(Effect.flip);
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      if (error._tag !== "VcsRepositoryDetectionError") return;
      assert.strictEqual(error.operation, "ReviewService.assertWorkspaceBoundCwd.canonicalizePath");
      assert.strictEqual(error.cwd, invalidCwd);
      assert.match(error.detail, /Failed to resolve a path/);
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
