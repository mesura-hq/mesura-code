import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";
import * as SqlClient from "effect/sql/SqlClient";
import { ProjectId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
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
  readonly threadWorktrees?: ReadonlyArray<{ worktreePath: string; deleted?: boolean }>;
  /** What `git worktree list` reports for every project. */
  readonly gitWorktrees?: ReadonlyArray<string>;
}) {
  const projectRoots = input.projectRoots ?? [];
  return ReviewService.layer.pipe(
    Layer.provide(KnownWorkspaces.layer),
    Layer.provide(
      Layer.effectDiscard(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (const [index, thread] of (input.threadWorktrees ?? []).entries()) {
            yield* sql`
              INSERT INTO orchestration_v2_projection_threads (
                thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
                created_at, updated_at, deleted_at, payload_json
              ) VALUES (
                ${`thread-${index}`}, 'project-0', 'Thread', 'codex', 'full-access', 'default',
                '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
                ${thread.deleted ? "2026-01-02T00:00:00.000Z" : null},
                ${JSON.stringify({ worktreePath: thread.worktreePath })}
              )
            `;
          }
        }),
      ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        listShells: () =>
          projectRoots === "unavailable"
            ? Effect.fail(
                new ProjectStore.ProjectStoreV2Error({ operation: "list", cause: "offline" }),
              )
            : Effect.succeed(
                projectRoots.map((workspaceRoot, index) => ({
                  id: ProjectId.make(`project-${index}`),
                  title: `Project ${index}`,
                  workspaceRoot,
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                })),
              ),
      }),
    ),
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
        listWorktreePaths: () => Effect.succeed([...(input.gitWorktrees ?? [])]),
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
        // These assertions inspect only failures. Normalize unused successful
        // values so every attempt has the same success type.
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
          const result = yield* Effect.result(attempt);
          if (result._tag !== "Failure") {
            assert.fail(`Expected ${operation} to deny ${scenario} before any repository read.`);
          }
          const error = result.failure;
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

  it.effect("allows registered project roots outside the server cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
      const projectChild = `${projectRoot}/packages/app`;
      yield* fs.makeDirectory(projectChild, { recursive: true });
      const sibling = `${projectRoot}-sibling`;
      yield* fs.makeDirectory(sibling);
      yield* Effect.addFinalizer(() => fs.remove(sibling, { recursive: true }).pipe(Effect.ignore));

      const review = (cwd: string, projectRoots: ReadonlyArray<string> | "unavailable") =>
        Effect.gen(function* () {
          const service = yield* ReviewService.ReviewService;
          return yield* service.getDiffPreview({ cwd });
        }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, projectRoots })));

      assert.strictEqual((yield* review(projectRoot, [projectRoot])).cwd, projectRoot);
      assert.strictEqual((yield* review(projectChild, [projectRoot])).cwd, projectChild);
      // A child whose name starts with `..` is still inside.
      const dottedChild = `${projectRoot}/..feature`;
      yield* fs.makeDirectory(dottedChild);
      assert.strictEqual((yield* review(dottedChild, [projectRoot])).cwd, dottedChild);
      for (const [cwd, projectRoots] of [
        [sibling, [projectRoot]],
        [projectRoot, []],
        [projectRoot, "unavailable"],
      ] as const) {
        const error = yield* review(cwd, projectRoots).pipe(Effect.flip);
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows the worktree a thread is bound to, and nothing else outside the project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const project = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
      // Checkouts outside every managed folder, as `git worktree add ../feature` makes.
      const bound = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-bound-" });
      const deleted = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-deleted-" });
      const unbound = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-unbound-" });
      // A client can set a thread's path to any folder; git doesn't list this one.
      const claimed = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-claimed-" });
      yield* fs.makeDirectory(`${bound}/sub`);

      const review = (cwd: string) =>
        Effect.gen(function* () {
          const service = yield* ReviewService.ReviewService;
          return yield* service.getDiffPreview({ cwd });
        }).pipe(
          Effect.provide(
            layer({
              workspaceRoot,
              baseDir,
              projectRoots: [project],
              gitWorktrees: [project, bound, deleted],
              threadWorktrees: [
                { worktreePath: bound },
                { worktreePath: claimed },
                { worktreePath: deleted, deleted: true },
                // A relative path would resolve against the server's own cwd.
                { worktreePath: "t3-review-relative" },
                // A filesystem root would make every folder look bound.
                { worktreePath: "/" },
              ],
            }),
          ),
        );

      for (const cwd of [bound, `${bound}/sub`]) {
        assert.strictEqual((yield* review(cwd)).cwd, cwd);
      }
      for (const cwd of [deleted, unbound, claimed, `${process.cwd()}/t3-review-relative`]) {
        const error = yield* review(cwd).pipe(Effect.flip);
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows a thread's worktree linked from a managed folder to a checkout elsewhere", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const managed = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-worktrees-" }),
      );
      const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-checkout-" });
      yield* fs.symlink(checkout, `${managed}/feature`);

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: checkout });
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            baseDir,
            worktreesDirectory: managed,
            threadWorktrees: [{ worktreePath: `${managed}/feature` }],
          }),
        ),
      );
      assert.strictEqual(result.cwd, checkout);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
