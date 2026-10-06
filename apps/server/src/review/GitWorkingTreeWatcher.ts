// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fork addition: keeps one cwd's working-tree changes live for the Git status
 * surface.
 *
 * One session per cwd, shared by every subscriber on it and released by the
 * last one to leave. A session arms one non-recursive `fs.watch` per directory
 * that holds a tracked or untracked-but-not-ignored file, plus the git dir
 * (index, HEAD, MERGE_HEAD) and the directory of the current branch's ref.
 * Any event re-reads the changes after a debounce; a result equal to the last
 * one published is dropped.
 *
 * Every scan arms its watches before it reads. An edit that lands during the
 * read is then queued as an event and read again, rather than lost between a
 * read that missed it and a watch that did not exist yet.
 *
 * Deliberately never `recursive: true` and never `@parcel/watcher`: both
 * descend into ignored trees such as `node_modules` and exhaust the inotify
 * budget. See the measured failure in
 * `vendor/symmetria-file-manager/packages/fm-main/src/fs/watch.ts`.
 *
 * @module GitWorkingTreeWatcher
 */
import * as NodeFS from "node:fs";

import { type GitCommandError, GitWorkingTreeChangesResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { readWorkingTreeChanges } from "./GitWorkingTreeChanges.ts";

/** A commit writes the index, HEAD and a ref within milliseconds of each other. */
const EVENT_DEBOUNCE = Duration.millis(200);
const LS_FILES_MAX_BYTES = 64 * 1024 * 1024;

const resultsEqual = Schema.toEquivalence(GitWorkingTreeChangesResult);

/** The parent of a git path, which always uses `/`; `.` at the top. */
const gitParentDirectory = (relativePath: string) => {
  const slash = relativePath.lastIndexOf("/");
  return slash === -1 ? "." : relativePath.slice(0, slash);
};

type WatchKind = "worktree" | "git";

export interface WatcherTuning {
  /** Past this many directories, only the git dir is watched and the tree is polled. */
  readonly maxWatchedDirectories: number;
  readonly overLimitPoll: Duration.Input;
  /** Runs after each working-tree read, before its result is compared. */
  readonly afterRead: (cwd: string) => void;
  /** Runs after each re-scan, initial read excluded, saying whether it published. */
  readonly afterRescan: (cwd: string, outcome: { readonly published: boolean }) => void;
  readonly afterWatchArmed: (directory: string, watcher: NodeFS.FSWatcher) => void;
}

/**
 * Limits and test seams. Production runs on the defaults; tests provide this
 * reference to shrink the directory cap and to observe scans and watches.
 */
export class GitWorkingTreeWatcherTuning extends Context.Reference<WatcherTuning>(
  "t3/review/GitWorkingTreeWatcherTuning",
  {
    defaultValue: () => ({
      maxWatchedDirectories: 10_000,
      overLimitPoll: Duration.seconds(5),
      afterRead: () => {},
      afterRescan: () => {},
      afterWatchArmed: () => {},
    }),
  },
) {}

interface ArmedWatch {
  readonly kind: WatchKind;
  readonly watcher: NodeFS.FSWatcher;
}

interface Session {
  readonly results: SubscriptionRef.SubscriptionRef<GitWorkingTreeChangesResult>;
  readonly scope: Scope.Closeable;
  readonly watches: Map<string, ArmedWatch>;
  subscribers: number;
}

interface WatchLayout {
  readonly directories: ReadonlyMap<string, WatchKind>;
  readonly overLimit: boolean;
}

export class GitWorkingTreeWatcher extends Context.Service<
  GitWorkingTreeWatcher,
  {
    /**
     * The cwd's changes now, then again each time they differ. The caller is
     * responsible for checking that the cwd may be read.
     */
    readonly watch: (cwd: string) => Stream.Stream<GitWorkingTreeChangesResult, GitCommandError>;
    /** Test-only: the absolute path of every armed watch, across all sessions. */
    readonly armedWatchPaths: Effect.Effect<ReadonlyArray<string>>;
  }
>()("t3/review/GitWorkingTreeWatcher") {}

/** Every directory holding one of `relativeFiles`, with its ancestors, as absolute paths. */
function directoriesHoldingFiles(
  path: Path.Path,
  root: string,
  relativeFiles: ReadonlyArray<string>,
): Set<string> {
  const relativeDirectories = new Set<string>();
  for (const file of relativeFiles) {
    let directory = gitParentDirectory(file);
    while (directory !== "." && !relativeDirectories.has(directory)) {
      relativeDirectories.add(directory);
      directory = gitParentDirectory(directory);
    }
  }
  const absolute = new Set([root]);
  for (const directory of relativeDirectories) absolute.add(path.join(root, directory));
  return absolute;
}

export const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tuning = yield* GitWorkingTreeWatcherTuning;
  const readDependencies = { git, fileSystem, path };

  const sessions = new Map<string, Session>();
  const sessionsLock = yield* Semaphore.make(1);

  const runGit = (cwd: string, operation: string, args: ReadonlyArray<string>) =>
    git.execute({
      operation: `GitWorkingTreeWatcher.${operation}`,
      cwd,
      args,
      allowNonZeroExit: true,
      maxOutputBytes: LS_FILES_MAX_BYTES,
    });

  /** The directories to watch for this cwd, read without the working-tree changes. */
  const readWatchLayout = Effect.fn("GitWorkingTreeWatcher.readWatchLayout")(function* (
    cwd: string,
  ) {
    const directories = new Map<string, WatchKind>();
    const [gitPaths, headRef] = yield* Effect.all(
      [
        runGit(cwd, "gitPaths", [
          "rev-parse",
          "--path-format=absolute",
          "--show-toplevel",
          "--git-dir",
          "--git-common-dir",
        ]),
        // `refs/heads/<branch>`, also on an unborn branch; exits 1 when detached.
        runGit(cwd, "headRef", ["symbolic-ref", "-q", "HEAD"]),
      ],
      { concurrency: "unbounded" },
    );
    const [root, gitDir, commonDir] = gitPaths.stdout.split("\n");
    if (gitPaths.exitCode !== 0 || !root || !gitDir || !commonDir) {
      // Not a repository: watching the cwd itself notices a `git init`.
      directories.set(cwd, "worktree");
      return { directories, overLimit: false } satisfies WatchLayout;
    }

    const files = yield* runGit(root, "files", [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ]);
    const worktreeDirectories = directoriesHoldingFiles(
      path,
      root,
      files.exitCode === 0 ? files.stdout.split("\0").filter((file) => file.length > 0) : [],
    );
    const overLimit = worktreeDirectories.size > tuning.maxWatchedDirectories;
    if (!overLimit) {
      for (const directory of worktreeDirectories) directories.set(directory, "worktree");
    }
    directories.set(gitDir, "git");
    const branchRef = headRef.exitCode === 0 ? headRef.stdout.replace(/\r?\n$/, "") : "";
    if (branchRef.startsWith("refs/")) {
      // Refs are replaced by rename, so the ref's directory is what is watched.
      directories.set(path.dirname(path.join(commonDir, branchRef)), "git");
    }
    return { directories, overLimit } satisfies WatchLayout;
  });

  /** Closes watches no longer wanted and arms the new ones. Never fails. */
  const reconcileWatches = (
    watches: Map<string, ArmedWatch>,
    layout: WatchLayout,
    trigger: Queue.Queue<void>,
  ): void => {
    for (const [directory, armed] of watches) {
      if (layout.directories.get(directory) !== armed.kind) {
        // Unregistered before closing, so its `close` asks for no re-scan.
        watches.delete(directory);
        armed.watcher.close();
      }
    }
    for (const [directory, kind] of layout.directories) {
      if (watches.has(directory)) continue;
      try {
        const watcher = NodeFS.watch(directory, { recursive: false }, (_event, filename) => {
          // git takes `index.lock` and friends before every write; the rename
          // that follows names the real file. A `.lock` in the tree is a file.
          if (kind === "git" && filename !== null && filename.endsWith(".lock")) return;
          Queue.offerUnsafe(trigger, undefined);
        });
        watcher.on("error", () => watcher.close());
        // A watch that ends while still registered died on its own: drop it
        // and re-scan, which arms the directory again if it is still wanted.
        watcher.on("close", () => {
          if (watches.get(directory)?.watcher !== watcher) return;
          watches.delete(directory);
          Queue.offerUnsafe(trigger, undefined);
        });
        watches.set(directory, { kind, watcher });
        tuning.afterWatchArmed(directory, watcher);
      } catch {
        // The directory went away between the listing and the watch. The
        // next scan sees the new layout.
      }
    }
  };

  /** The watch set brought up to date, then one read. The order is the point. */
  const scan = (cwd: string, watches: Map<string, ArmedWatch>, trigger: Queue.Queue<void>) =>
    Effect.gen(function* () {
      const layout = yield* readWatchLayout(cwd);
      reconcileWatches(watches, layout, trigger);
      const result = yield* readWorkingTreeChanges(readDependencies, cwd);
      tuning.afterRead(cwd);
      return { result, overLimit: layout.overLimit };
    });

  const openSession = Effect.fn("GitWorkingTreeWatcher.openSession")(function* (cwd: string) {
    const scope = yield* Scope.make("sequential");
    const watches = new Map<string, ArmedWatch>();
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        const armed = [...watches.values()];
        watches.clear();
        for (const { watcher } of armed) watcher.close();
      }),
    );
    const trigger = yield* Queue.unbounded<void>();

    const first = yield* scan(cwd, watches, trigger).pipe(
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
    const results = yield* SubscriptionRef.make(first.result);

    let lastPublished = first.result;
    let overLimit = first.overLimit;
    const rescan = scan(cwd, watches, trigger).pipe(
      Effect.flatMap((next) =>
        Effect.gen(function* () {
          overLimit = next.overLimit;
          const published = !resultsEqual(next.result, lastPublished);
          if (published) {
            lastPublished = next.result;
            yield* SubscriptionRef.set(results, next.result);
          }
          tuning.afterRescan(cwd, { published });
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("GitWorkingTreeWatcher: re-read failed", { cwd, cause }),
      ),
    );

    const events = Stream.fromQueue(trigger).pipe(Stream.debounce(EVENT_DEBOUNCE));
    const overLimitPolls = Stream.fromSchedule(Schedule.spaced(tuning.overLimitPoll)).pipe(
      Stream.filter(() => overLimit),
    );
    yield* Stream.runForEach(Stream.merge(events, overLimitPolls), () => rescan).pipe(
      Effect.forkIn(scope),
    );
    return { results, scope, watches, subscribers: 1 } satisfies Session;
  });

  const acquire = (cwd: string) =>
    sessionsLock.withPermits(1)(
      Effect.gen(function* () {
        const existing = sessions.get(cwd);
        if (existing) {
          existing.subscribers += 1;
          return existing;
        }
        const session = yield* openSession(cwd);
        sessions.set(cwd, session);
        return session;
      }),
    );

  const release = (cwd: string, session: Session) =>
    sessionsLock.withPermits(1)(
      Effect.gen(function* () {
        session.subscribers -= 1;
        if (session.subscribers > 0) return;
        if (sessions.get(cwd) === session) sessions.delete(cwd);
        yield* Scope.close(session.scope, Exit.void);
      }),
    );

  const watch: GitWorkingTreeWatcher["Service"]["watch"] = (cwd) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const session = yield* Effect.acquireRelease(acquire(cwd), (acquired) =>
          release(cwd, acquired),
        );
        return SubscriptionRef.changes(session.results);
      }),
    );

  const armedWatchPaths = Effect.sync(() =>
    [...sessions.values()].flatMap((session) => [...session.watches.keys()]),
  );

  // Sessions still open when the layer goes away release their watches too.
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...sessions.values()], (session) => Scope.close(session.scope, Exit.void), {
      discard: true,
    }),
  );

  return GitWorkingTreeWatcher.of({ watch, armedWatchPaths });
});

export const layer = Layer.effect(GitWorkingTreeWatcher, make);
