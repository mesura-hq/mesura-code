// @effect-diagnostics nodeBuiltinImport:off - the fixture drives real git and the real disk synchronously.
/**
 * Specs for the live working-tree changes stream.
 *
 * Entry point: `ReviewService.subscribeWorkingTreeChanges`, the method the
 * `review.subscribeWorkingTreeChanges` RPC serves in `ws.ts`. Each spec runs
 * the real `ReviewService.layer` over the real `GitWorkingTreeWatcher.layer`
 * and real git against a temp repository; `GitWorkingTreeWatcher` is read
 * directly only for its test-only `armedWatchPaths`.
 *
 * Waits are on emitted results or on completed re-scans, each with a timeout,
 * never on fixed sleeps. An "emits nothing" claim waits for the re-scan that
 * would have emitted, or, where no re-scan may run at all, for a bounded quiet
 * window on the re-scan probe; a sentinel change then proves the stream is
 * still live.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { GitWorkingTreeChangesResult } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitWorkingTreeWatcher from "./GitWorkingTreeWatcher.ts";
import * as ReviewService from "./ReviewService.ts";

/** The acceptance bound for a tracked-file edit. */
const TRACKED_EDIT_BOUND = Duration.seconds(1);
/** Generous bound for everything else, so a slow CI runner does not flake. */
const EMISSION_BOUND = Duration.seconds(5);

interface TempRepository {
  readonly root: string;
  readonly git: (...args: string[]) => string;
  readonly write: (relativePath: string, contents: string) => void;
  readonly dispose: () => void;
}

function makeTempRepository(prefix: string): TempRepository {
  const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix)));
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    });
  const write = (relativePath: string, contents: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, relativePath)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, relativePath), contents);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  write(".gitignore", "node_modules/\n");
  write("src/kept.ts", "one\ntwo\nthree\n");
  write("src/nested/deep.ts", "deep\n");
  write("both.ts", "1\n2\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  return { root, git, write, dispose: () => NodeFS.rmSync(root, { recursive: true, force: true }) };
}

const withTempRepository = <A, E, R>(
  prefix: string,
  use: (repository: TempRepository) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => makeTempRepository(prefix)),
    use,
    (repository) => Effect.sync(repository.dispose),
  );

/** How long a probe must stay quiet to show that no re-scan runs: five debounces. */
const QUIET_WINDOW = Duration.seconds(1);

type Tuning = GitWorkingTreeWatcher.WatcherTuning;

/** The real review stack, with `workspaceRoot` as the configured workspace root. */
function makeLayer(workspaceRoot: string, tuning: Layer.Layer<never> = Layer.empty) {
  return ReviewService.layer.pipe(
    Layer.provideMerge(GitWorkingTreeWatcher.layer),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsDriverRegistry.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provide(ServerConfig.layerTest(workspaceRoot, { prefix: "t3-tree-watch-base-" })),
    Layer.provideMerge(tuning),
    Layer.provideMerge(NodeServices.layer),
  );
}

/**
 * Observes the watcher through its tuning seams: every completed re-scan, and
 * the latest watch handle armed per directory.
 */
const makeProbe = Effect.fn("makeProbe")(function* (overrides: Partial<Tuning> = {}) {
  const defaults = yield* GitWorkingTreeWatcher.GitWorkingTreeWatcherTuning;
  const rescans = yield* Queue.unbounded<{ readonly published: boolean }>();
  const latestWatch = new Map<string, NodeFS.FSWatcher>();
  const tuning: Tuning = {
    ...defaults,
    afterRescan: (_cwd, outcome) => Queue.offerUnsafe(rescans, outcome),
    afterWatchArmed: (directory, watcher) => latestWatch.set(directory, watcher),
    ...overrides,
  };
  return {
    rescans,
    latestWatch,
    layer: Layer.succeed(GitWorkingTreeWatcher.GitWorkingTreeWatcherTuning, tuning),
  };
});

/** Subscribes through the RPC's service method and drains it into a queue. */
const subscribeIntoQueue = Effect.fn("subscribeIntoQueue")(function* (cwd: string) {
  const review = yield* ReviewService.ReviewService;
  const queue = yield* Queue.unbounded<GitWorkingTreeChangesResult>();
  const fiber = yield* Stream.runForEach(review.subscribeWorkingTreeChanges({ cwd }), (result) =>
    Queue.offer(queue, result),
  ).pipe(Effect.orDie, Effect.forkScoped);
  return { queue, fiber };
});

/** The next emission, or a failure naming what was awaited. */
const nextEmission = (
  queue: Queue.Queue<GitWorkingTreeChangesResult>,
  awaiting: string,
  bound: Duration.Input = EMISSION_BOUND,
) =>
  Queue.take(queue).pipe(
    Effect.timeoutOption(bound),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die(new Error(`no emission within the bound while ${awaiting}`)),
        onSome: Effect.succeed,
      }),
    ),
  );

/** The next completed re-scan, or a failure naming what was awaited. */
const nextRescan = (rescans: Queue.Queue<{ readonly published: boolean }>, awaiting: string) =>
  Queue.take(rescans).pipe(
    Effect.timeoutOption(EMISSION_BOUND),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die(new Error(`no re-scan within the bound while ${awaiting}`)),
        onSome: Effect.succeed,
      }),
    ),
  );

/** Re-scans until one publishes, so the scan behind an emission has finished. */
const untilPublishingRescan = (
  rescans: Queue.Queue<{ readonly published: boolean }>,
  awaiting: string,
): Effect.Effect<void> =>
  nextRescan(rescans, awaiting).pipe(
    Effect.flatMap((outcome) =>
      outcome.published ? Effect.void : untilPublishingRescan(rescans, awaiting),
    ),
  );

/** Fails if any re-scan completes within the quiet window. */
const expectNoRescan = (rescans: Queue.Queue<{ readonly published: boolean }>, after: string) =>
  Queue.take(rescans).pipe(
    Effect.timeoutOption(QUIET_WINDOW),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: () => Effect.die(new Error(`a re-scan ran ${after}`)),
      }),
    ),
  );

const fileByPath = (result: GitWorkingTreeChangesResult, path: string) =>
  result.files.find((file) => file.path === path);

describe("GitWorkingTreeWatcher via ReviewService.subscribeWorkingTreeChanges", () => {
  it.live(
    "watcher spec: emits one snapshot with letters, staged, unstaged and untracked counts",
    () =>
      withTempRepository("tree-watch-snapshot-", (repository) => {
        repository.write("src/kept.ts", "one\nTWO\nthree\nfour\n"); // unstaged +2 -1
        repository.write("both.ts", "1\n2\n3\n");
        repository.git("add", "both.ts"); // staged +1
        repository.write("docs/new.md", "x\ny\n"); // untracked, 2 lines
        return Effect.gen(function* () {
          const { queue } = yield* subscribeIntoQueue(repository.root);
          const snapshot = yield* nextEmission(queue, "waiting for the first snapshot");

          assert.strictEqual(snapshot.isRepo, true);
          assert.strictEqual(snapshot.repositoryRoot, repository.root);
          assert.strictEqual(snapshot.refName, "main");
          assert.deepInclude(fileByPath(snapshot, "src/kept.ts"), {
            index: ".",
            worktree: "M",
            staged: { insertions: 0, deletions: 0 },
            unstaged: { insertions: 2, deletions: 1 },
          });
          assert.deepInclude(fileByPath(snapshot, "both.ts"), {
            index: "M",
            worktree: ".",
            staged: { insertions: 1, deletions: 0 },
          });
          assert.deepInclude(fileByPath(snapshot, "docs/new.md"), {
            index: "?",
            worktree: "?",
            unstaged: { insertions: 2, deletions: 0 },
          });
          assert.strictEqual(snapshot.files.length, 3);
          // One snapshot, not one per file: nothing else is queued behind it.
          assert.strictEqual(yield* Queue.size(queue), 0);
        }).pipe(Effect.scoped, Effect.provide(makeLayer(repository.root)));
      }),
  );

  it.live("watcher spec: modifying a tracked file emits a new result within one second", () =>
    withTempRepository("tree-watch-modify-", (repository) =>
      Effect.gen(function* () {
        const { queue } = yield* subscribeIntoQueue(repository.root);
        const baseline = yield* nextEmission(queue, "waiting for the baseline");
        assert.deepStrictEqual(baseline.files, []);

        repository.write("src/nested/deep.ts", "deep\nchanged\n");
        const changed = yield* nextEmission(
          queue,
          "waiting for the tracked edit",
          TRACKED_EDIT_BOUND,
        );
        assert.deepInclude(fileByPath(changed, "src/nested/deep.ts"), {
          index: ".",
          worktree: "M",
          unstaged: { insertions: 1, deletions: 0 },
        });
      }).pipe(Effect.scoped, Effect.provide(makeLayer(repository.root))),
    ),
  );

  it.live("watcher spec: a file inside a directory created after subscribing emits", () =>
    withTempRepository("tree-watch-new-dir-", (repository) =>
      Effect.gen(function* () {
        const { queue } = yield* subscribeIntoQueue(repository.root);
        yield* nextEmission(queue, "waiting for the baseline");

        // The root's watch sees the new directory appear.
        repository.write("fresh/sub/first.ts", "a\n");
        const first = yield* nextEmission(queue, "waiting for the file in the new directory");
        assert.deepInclude(fileByPath(first, "fresh/sub/first.ts"), { index: "?", worktree: "?" });

        // Only a watch armed on `fresh/sub` itself sees this one: its parent
        // directories do not change. The watcher arms a scan's new directories
        // before it emits that scan's result.
        repository.write("fresh/sub/second.ts", "b\n");
        const second = yield* nextEmission(queue, "waiting for the second file in that directory");
        assert.deepInclude(fileByPath(second, "fresh/sub/second.ts"), {
          index: "?",
          worktree: "?",
        });
      }).pipe(Effect.scoped, Effect.provide(makeLayer(repository.root))),
    ),
  );

  it.live("watcher guard: a cwd below the root sees a file created and edited outside it", () =>
    withTempRepository("tree-watch-subdir-", (repository) => {
      // A project opened at a subfolder of its repository, as a dev server's
      // fallback to its own cwd (`apps/server`) is: git reports the whole
      // repository, so the watches must cover the whole repository too.
      const subdirectory = NodePath.join(repository.root, "src");
      return Effect.gen(function* () {
        const { queue } = yield* subscribeIntoQueue(subdirectory);
        yield* nextEmission(queue, "waiting for the baseline");

        repository.write("outside.ts", "first\n");
        const created = yield* nextEmission(queue, "waiting for the file created at the root");
        assert.deepInclude(fileByPath(created, "outside.ts"), {
          index: "?",
          worktree: "?",
          unstaged: { insertions: 1, deletions: 0 },
        });

        repository.write("outside.ts", "first\nsecond\n");
        const edited = yield* nextEmission(queue, "waiting for the edit at the root");
        assert.deepInclude(fileByPath(edited, "outside.ts"), {
          unstaged: { insertions: 2, deletions: 0 },
        });
      }).pipe(Effect.scoped, Effect.provide(makeLayer(subdirectory)));
    }),
  );

  it.live("watcher spec: git add and git commit each emit with no working-tree file touched", () =>
    withTempRepository("tree-watch-git-ops-", (repository) =>
      Effect.gen(function* () {
        repository.write("src/kept.ts", "one\ntwo\nthree\nfour\n");
        const { queue } = yield* subscribeIntoQueue(repository.root);
        const baseline = yield* nextEmission(queue, "waiting for the baseline");
        assert.deepInclude(fileByPath(baseline, "src/kept.ts"), { index: ".", worktree: "M" });

        repository.git("add", "src/kept.ts");
        const staged = yield* nextEmission(queue, "waiting for git add");
        assert.deepInclude(fileByPath(staged, "src/kept.ts"), {
          index: "M",
          worktree: ".",
          staged: { insertions: 1, deletions: 0 },
        });

        repository.git("commit", "-q", "-m", "second");
        const committed = yield* nextEmission(queue, "waiting for git commit");
        assert.deepStrictEqual(committed.files, []);
      }).pipe(Effect.scoped, Effect.provide(makeLayer(repository.root))),
    ),
  );

  it.live("watcher spec: an ignored directory gets no watch and its writes emit nothing", () =>
    withTempRepository("tree-watch-ignored-", (repository) => {
      repository.write("node_modules/pkg/lib/index.js", "module.exports = 1;\n");
      repository.write("node_modules/other/package.json", "{}\n");
      return Effect.gen(function* () {
        const probe = yield* makeProbe();
        yield* Effect.gen(function* () {
          const watcher = yield* GitWorkingTreeWatcher.GitWorkingTreeWatcher;
          const { queue } = yield* subscribeIntoQueue(repository.root);
          const baseline = yield* nextEmission(queue, "waiting for the baseline");
          assert.deepStrictEqual(baseline.files, []);

          const ignoredRoot = NodePath.join(repository.root, "node_modules");
          const armed = yield* watcher.armedWatchPaths;
          assert.include(armed, repository.root);
          assert.include(armed, NodePath.join(repository.root, "src", "nested"));
          assert.deepStrictEqual(
            armed.filter(
              (armedPath) =>
                armedPath === ignoredRoot || armedPath.startsWith(`${ignoredRoot}${NodePath.sep}`),
            ),
            [],
          );

          repository.write("node_modules/pkg/lib/index.js", "module.exports = 2;\n");
          repository.write("node_modules/pkg/lib/added.js", "x\n");
          // No watch sees these writes, so no re-scan runs and nothing is sent.
          yield* expectNoRescan(probe.rescans, "after writes inside node_modules");
          assert.strictEqual(yield* Queue.size(queue), 0);

          // Sentinel: the stream is still live.
          repository.write("src/kept.ts", "one\n");
          const next = yield* nextEmission(queue, "waiting for the sentinel edit");
          assert.deepStrictEqual(
            next.files.map((file) => file.path),
            ["src/kept.ts"],
          );
        }).pipe(Effect.scoped, Effect.provide(makeLayer(repository.root, probe.layer)));
      });
    }),
  );

  it.live("watcher spec: a re-read equal to the last result sent emits nothing", () =>
    withTempRepository("tree-watch-dedupe-", (repository) =>
      Effect.gen(function* () {
        const probe = yield* makeProbe();
        repository.write("src/kept.ts", "one\ntwo\nthree\nfour\n");
        yield* Effect.gen(function* () {
          const { queue } = yield* subscribeIntoQueue(repository.root);
          yield* nextEmission(queue, "waiting for the baseline");

          // Same bytes again: the watch fires and the re-read runs to the end.
          repository.write("src/kept.ts", "one\ntwo\nthree\nfour\n");
          const outcome = yield* nextRescan(probe.rescans, "waiting for the unchanged re-read");
          assert.strictEqual(outcome.published, false);
          assert.strictEqual(yield* Queue.size(queue), 0);

          // Sentinel: the next emission carries this change.
          repository.write("both.ts", "1\n");
          const next = yield* nextEmission(queue, "waiting for the sentinel edit");
          assert.deepStrictEqual(
            next.files.map((file) => file.path),
            ["both.ts", "src/kept.ts"],
          );
        }).pipe(Effect.scoped, Effect.provide(makeLayer(repository.root, probe.layer)));
      }),
    ),
  );

  it.live("watcher spec: two subscribers share one set of watches and the last releases them", () =>
    withTempRepository("tree-watch-shared-", (repository) =>
      Effect.gen(function* () {
        const watcher = yield* GitWorkingTreeWatcher.GitWorkingTreeWatcher;
        assert.deepStrictEqual(yield* watcher.armedWatchPaths, []);

        const first = yield* subscribeIntoQueue(repository.root);
        yield* nextEmission(first.queue, "waiting for the first subscriber's baseline");
        const armedForOne = yield* watcher.armedWatchPaths;
        assert.isAbove(armedForOne.length, 0);

        const second = yield* subscribeIntoQueue(repository.root);
        yield* nextEmission(second.queue, "waiting for the second subscriber's baseline");
        assert.deepStrictEqual((yield* watcher.armedWatchPaths).toSorted(), armedForOne.toSorted());

        // Both subscribers see one change.
        repository.write("both.ts", "changed\n");
        yield* nextEmission(first.queue, "waiting for the first subscriber's update");
        yield* nextEmission(second.queue, "waiting for the second subscriber's update");

        yield* Fiber.interrupt(first.fiber);
        assert.isAbove((yield* watcher.armedWatchPaths).length, 0);

        yield* Fiber.interrupt(second.fiber);
        assert.deepStrictEqual(yield* watcher.armedWatchPaths, []);
      }).pipe(Effect.scoped, Effect.provide(makeLayer(repository.root))),
    ),
  );

  it.live("watcher spec: a cwd outside the workspace fails like the one-shot read", () =>
    withTempRepository("tree-watch-outside-", (repository) => {
      const workspaceRoot = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tree-watch-workspace-")),
      );
      return Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        const oneShotError = yield* review
          .getWorkingTreeChanges({ cwd: repository.root })
          .pipe(Effect.flip);
        const streamError = yield* Stream.runCollect(
          review.subscribeWorkingTreeChanges({ cwd: repository.root }),
        ).pipe(Effect.flip);

        assert.strictEqual(streamError._tag, "VcsRepositoryDetectionError");
        assert.strictEqual(oneShotError._tag, "VcsRepositoryDetectionError");
        if (
          streamError._tag !== "VcsRepositoryDetectionError" ||
          oneShotError._tag !== "VcsRepositoryDetectionError"
        ) {
          return;
        }
        assert.strictEqual(streamError.cwd, repository.root);
        assert.strictEqual(streamError.detail, oneShotError.detail);
        assert.match(streamError.detail, /must stay within the configured workspace root/);

        const watcher = yield* GitWorkingTreeWatcher.GitWorkingTreeWatcher;
        assert.deepStrictEqual(yield* watcher.armedWatchPaths, []);
      }).pipe(
        Effect.provide(makeLayer(workspaceRoot)),
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(workspaceRoot, { recursive: true, force: true })),
        ),
      );
    }),
  );
});

describe("GitWorkingTreeWatcher recovery and limits", () => {
  it.live("watcher guard: an edit made while the initial read runs is not lost", () =>
    withTempRepository("tree-watch-initial-window-", (repository) =>
      Effect.gen(function* () {
        let edited = false;
        const probe = yield* makeProbe({
          // Lands after the first read and before its result is sent.
          afterRead: () => {
            if (edited) return;
            edited = true;
            repository.write("src/kept.ts", "edited during the read\n");
          },
        });
        yield* Effect.gen(function* () {
          const { queue } = yield* subscribeIntoQueue(repository.root);
          const baseline = yield* nextEmission(queue, "waiting for the baseline");
          assert.deepStrictEqual(baseline.files, []);
          const next = yield* nextEmission(queue, "waiting for the edit made during the read");
          assert.deepInclude(fileByPath(next, "src/kept.ts"), { index: ".", worktree: "M" });
        }).pipe(Effect.scoped, Effect.provide(makeLayer(repository.root, probe.layer)));
      }),
    ),
  );

  it.live("watcher guard: a scan never causes another scan", () =>
    withTempRepository("tree-watch-no-loop-", (repository) =>
      Effect.gen(function* () {
        const probe = yield* makeProbe();
        yield* Effect.gen(function* () {
          const { queue } = yield* subscribeIntoQueue(repository.root);
          yield* nextEmission(queue, "waiting for the baseline");
          // The initial read must not wake the watcher either.
          yield* expectNoRescan(probe.rescans, "after the initial read");

          repository.write("src/kept.ts", "one\n");
          yield* nextEmission(queue, "waiting for the edit");
          yield* untilPublishingRescan(probe.rescans, "waiting for the edit's re-scan");
          yield* expectNoRescan(probe.rescans, "after the edit's re-scan");

          // `git add` rewrites the index, the file the git-dir watch is for.
          repository.git("add", "src/kept.ts");
          yield* nextEmission(queue, "waiting for git add");
          yield* untilPublishingRescan(probe.rescans, "waiting for git add's re-scan");
          yield* expectNoRescan(probe.rescans, "after git add's re-scan");
        }).pipe(Effect.scoped, Effect.provide(makeLayer(repository.root, probe.layer)));
      }),
    ),
  );

  const recoversFrom = (
    title: string,
    prefix: string,
    endWatch: (watcher: NodeFS.FSWatcher) => void,
  ) =>
    it.live(title, () =>
      withTempRepository(prefix, (repository) =>
        Effect.gen(function* () {
          const probe = yield* makeProbe();
          yield* Effect.gen(function* () {
            const watcher = yield* GitWorkingTreeWatcher.GitWorkingTreeWatcher;
            const { queue } = yield* subscribeIntoQueue(repository.root);
            yield* nextEmission(queue, "waiting for the baseline");

            const nested = NodePath.join(repository.root, "src", "nested");
            const original = probe.latestWatch.get(nested);
            assert.isDefined(original);
            endWatch(original!);

            yield* nextRescan(probe.rescans, "waiting for the re-scan the ended watch asks for");
            assert.include(yield* watcher.armedWatchPaths, nested);
            assert.notStrictEqual(probe.latestWatch.get(nested), original);

            // The replacement watch sees an edit only it can see.
            repository.write("src/nested/deep.ts", "deep\nafter recovery\n");
            const next = yield* nextEmission(queue, "waiting for the edit under the new watch");
            assert.deepInclude(fileByPath(next, "src/nested/deep.ts"), { worktree: "M" });
          }).pipe(Effect.scoped, Effect.provide(makeLayer(repository.root, probe.layer)));
        }),
      ),
    );

  recoversFrom(
    "watcher guard: a watch closed from outside is armed again",
    "tree-watch-closed-",
    (watcher) => watcher.close(),
  );

  recoversFrom(
    "watcher guard: a watch that errors is armed again",
    "tree-watch-errored-",
    (watcher) => watcher.emit("error", new Error("simulated watch failure")),
  );

  it.live("watcher guard: past the directory cap only git is watched and the tree is polled", () =>
    withTempRepository("tree-watch-cap-", (repository) =>
      Effect.gen(function* () {
        // The fixture has three directories: the root, `src` and `src/nested`.
        const probe = yield* makeProbe({
          maxWatchedDirectories: 3,
          overLimitPoll: Duration.millis(300),
        });
        yield* Effect.gen(function* () {
          const watcher = yield* GitWorkingTreeWatcher.GitWorkingTreeWatcher;
          const gitDir = NodePath.join(repository.root, ".git");
          const isGitPath = (armedPath: string) =>
            armedPath === gitDir || armedPath.startsWith(`${gitDir}${NodePath.sep}`);
          const { queue } = yield* subscribeIntoQueue(repository.root);
          yield* nextEmission(queue, "waiting for the baseline");
          assert.include(yield* watcher.armedWatchPaths, repository.root);

          // A fourth directory crosses the cap.
          repository.write("extra/new.ts", "x\n");
          const over = yield* nextEmission(queue, "waiting for the scan that crosses the cap");
          assert.isDefined(fileByPath(over, "extra/new.ts"));
          const armedOver = yield* watcher.armedWatchPaths;
          assert.isAbove(armedOver.length, 0);
          assert.deepStrictEqual(
            armedOver.filter((armedPath) => !isGitPath(armedPath)),
            [],
          );

          // No tree watch is armed: only the poll can see this edit.
          repository.write("src/kept.ts", "polled\n");
          const polled = yield* nextEmission(queue, "waiting for the poll to see the edit");
          assert.deepInclude(fileByPath(polled, "src/kept.ts"), { worktree: "M" });

          // Back under the cap, the tree is watched again.
          NodeFS.rmSync(NodePath.join(repository.root, "extra"), { recursive: true });
          const under = yield* nextEmission(queue, "waiting for the scan back under the cap");
          assert.isUndefined(fileByPath(under, "extra/new.ts"));
          const armedUnder = yield* watcher.armedWatchPaths;
          assert.include(armedUnder, repository.root);
          assert.include(armedUnder, NodePath.join(repository.root, "src", "nested"));
        }).pipe(Effect.scoped, Effect.provide(makeLayer(repository.root, probe.layer)));
      }),
    ),
  );
});

describe("GitWorkingTreeWatcher regression guards", () => {
  it.effect(
    "watcher guard: production defaults keep the 10,000-directory cap and 5-second poll",
    () =>
      Effect.gen(function* () {
        const defaults = yield* GitWorkingTreeWatcher.GitWorkingTreeWatcherTuning;
        assert.strictEqual(defaults.maxWatchedDirectories, 10_000);
        assert.isTrue(
          Duration.equals(Duration.fromInputUnsafe(defaults.overLimitPoll), Duration.seconds(5)),
        );
      }),
  );

  it.live("watcher guard: a .lock file in the tree emits but one in the git dir does not", () =>
    withTempRepository("tree-watch-lock-files-", (repository) =>
      Effect.gen(function* () {
        repository.write("Cargo.lock", "v1\n");
        repository.git("add", "Cargo.lock");
        repository.git("commit", "-q", "-m", "lockfile");
        const probe = yield* makeProbe();
        yield* Effect.gen(function* () {
          const { queue } = yield* subscribeIntoQueue(repository.root);
          yield* nextEmission(queue, "waiting for the baseline");

          // git's own lock files in the git dir are not changes.
          NodeFS.writeFileSync(NodePath.join(repository.root, ".git", "stray.lock"), "");
          yield* expectNoRescan(probe.rescans, "after a lock file appeared in the git dir");

          // A tracked `.lock` in the tree is an ordinary file.
          repository.write("Cargo.lock", "v2\n");
          const next = yield* nextEmission(queue, "waiting for the tracked lockfile edit");
          assert.deepInclude(fileByPath(next, "Cargo.lock"), { worktree: "M" });
        }).pipe(Effect.scoped, Effect.provide(makeLayer(repository.root, probe.layer)));
      }),
    ),
  );

  it.live("watcher guard: a non-repository cwd emits isRepo false, then git init emits", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        NodeFS.realpathSync(
          NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tree-watch-not-a-repo-")),
        ),
      ),
      (directory) =>
        Effect.gen(function* () {
          const { queue } = yield* subscribeIntoQueue(directory);
          const baseline = yield* nextEmission(queue, "waiting for the non-repository baseline");
          assert.strictEqual(baseline.isRepo, false);

          NodeChildProcess.execFileSync("git", ["init", "-q", "-b", "main"], { cwd: directory });
          const initialized = yield* nextEmission(queue, "waiting for git init");
          assert.strictEqual(initialized.isRepo, true);
          assert.strictEqual(initialized.repositoryRoot, directory);
        }).pipe(Effect.scoped, Effect.provide(makeLayer(directory))),
      (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
    ),
  );

  it.live("watcher guard: moving a slashed branch's ref emits with no index or tree change", () =>
    withTempRepository("tree-watch-branch-ref-", (repository) =>
      Effect.gen(function* () {
        repository.git("checkout", "-q", "-b", "feat/tree-diff");
        repository.write("both.ts", "second\n");
        repository.git("commit", "-q", "-am", "second");
        yield* Effect.gen(function* () {
          const { queue } = yield* subscribeIntoQueue(repository.root);
          const baseline = yield* nextEmission(queue, "waiting for the baseline");
          assert.strictEqual(baseline.refName, "feat/tree-diff");
          assert.deepStrictEqual(baseline.files, []);

          // Only `refs/heads/feat/tree-diff` changes: the index and tree keep
          // the second commit, which is now a staged change against HEAD.
          repository.git("update-ref", "refs/heads/feat/tree-diff", "HEAD~1");
          const moved = yield* nextEmission(queue, "waiting for the moved branch ref");
          assert.deepInclude(fileByPath(moved, "both.ts"), { index: "M", worktree: "." });
        }).pipe(Effect.scoped, Effect.provide(makeLayer(repository.root)));
      }),
    ),
  );
});
