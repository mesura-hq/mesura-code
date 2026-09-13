// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceFileWatcher - watches one project file and reports that it changed.
 *
 * Reports a revision rather than contents. The client re-reads through
 * `projects.readFile`, so truncation, binary detection and the path-escape
 * checks keep one definition and the stream stays small.
 *
 * @module WorkspaceFileWatcher
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import type { ProjectFileWatchEvent, ProjectReadFileInput } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import type * as WorkspacePaths from "./WorkspacePaths.ts";

/** Re-exported so tests and callers can name the event without a second import. */
export type ProjectFileWatchEventOut = ProjectFileWatchEvent;

/** Editors emit several events per save, and the watch fires before the content lands. */
const WATCH_DEBOUNCE = Duration.millis(100);

/**
 * How often to re-check a file the watch has already reported missing.
 *
 * Deleting the file's parent directory leaves the underlying watch inert on
 * most platforms: it stops reporting and raises neither `error` nor `close`, so
 * recreating that directory would otherwise go unnoticed forever. While the
 * file is present this tick only reads a `Ref` and produces nothing.
 */
const ABSENT_FILE_RECHECK = Duration.seconds(3);

export class WorkspaceFileWatcher extends Context.Service<
  WorkspaceFileWatcher,
  {
    /**
     * Watch one workspace-relative file.
     *
     * Emits one baseline `changed` carrying the current revision before any
     * disk event, so a client that reconnects can tell whether the file moved
     * while it was away.
     */
    readonly watchFile: (
      input: ProjectReadFileInput,
    ) => Stream.Stream<
      ProjectFileWatchEvent,
      WorkspaceFileSystem.WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
  }
>()("t3/workspace/WorkspaceFileWatcher") {}

export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;

  const watchFile: WorkspaceFileWatcher["Service"]["watchFile"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const { realTargetPath, relativePath } =
          yield* workspaceFileSystem.resolveRealFilePath(input);
        const directory = path.dirname(realTargetPath);
        const fileName = path.basename(realTargetPath);
        // null means "not there, as far as this subscription knows", which is
        // also the state a `removed` event leaves behind.
        const lastRevision = yield* Ref.make<string | null>(null);

        const watchFailed = (cause: unknown) =>
          new WorkspaceFileSystem.WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: directory,
            operation: "watch",
            cause,
          });

        const triggers = yield* Queue.unbounded<
          string,
          WorkspaceFileSystem.WorkspaceFileSystemOperationError | Cause.Done
        >();

        /**
         * The watch is acquired HERE, before the baseline below is taken.
         *
         * The order matters and the obvious arrangement gets it backwards: a
         * stream that concatenates the baseline in front of the watch only
         * establishes the watch once the baseline has been pulled, so a write
         * landing between the two is never seen and the client goes on
         * believing a stale revision is current.
         *
         * The directory is watched rather than the file because editors and git
         * replace a file by writing a sibling and renaming it over the target;
         * a watch on the file's own inode goes stale the first time that
         * happens.
         *
         * Deliberately not Effect's `fs.watch`: its Node backend passes
         * `recursive: true`, so watching the directory of a file at a workspace
         * root would walk the whole repository, `node_modules` included. The
         * configuration-directory watchers elsewhere in this server get away
         * with that because their directories are tiny.
         */
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const watcher = NodeFS.watch(directory, { recursive: false }, (_event, filename) => {
              if (filename === null) return;
              Queue.offerUnsafe(triggers, filename);
            });
            // A watch that dies is reported, not swallowed: an inert watcher
            // looks exactly like a file nobody is touching.
            watcher.on("error", (cause) => {
              Queue.failCauseUnsafe(triggers, Cause.fail(watchFailed(cause)));
            });
            // `close` also fires from the release below, where ending is right.
            watcher.on("close", () => {
              Queue.endUnsafe(triggers);
            });
            return watcher;
          }),
          (watcher) => Effect.sync(() => watcher.close()),
        );

        /** The event this check should produce, or null when nothing moved. */
        const nextEvent = Effect.gen(function* () {
          // Only a missing file is an ordinary outcome. A permission error or
          // descriptor exhaustion must not be reported as a deletion.
          const stat = yield* Effect.tryPromise({
            try: () =>
              NodeFSP.stat(realTargetPath).then(
                (found): NodeFS.Stats | null => found,
                (cause: NodeJS.ErrnoException): null => {
                  if (cause.code === "ENOENT" || cause.code === "ENOTDIR") return null;
                  throw cause;
                },
              ),
            catch: watchFailed,
          });

          if (stat === null) {
            const previous = yield* Ref.get(lastRevision);
            if (previous === null) return null;
            yield* Ref.set(lastRevision, null);
            return { type: "removed", relativePath } as const;
          }

          // Coarse where a filesystem keeps mtime to the second: two writes of
          // equal length inside one tick read as unchanged. Acceptable, because
          // the next real change reports itself and the client re-reads then.
          const revision = `${stat.mtimeMs}:${stat.size}`;
          const previous = yield* Ref.get(lastRevision);
          if (previous === revision) return null;
          yield* Ref.set(lastRevision, revision);
          return { type: "changed", relativePath, revision } as const;
        });

        const directoryName = path.basename(directory);
        const directoryChanges = Stream.fromQueue(triggers).pipe(
          Stream.filter(
            (name) =>
              name === fileName ||
              path.resolve(directory, name) === realTargetPath ||
              // An event naming the watched directory itself, which is how a
              // permission change on that directory arrives. Without this the
              // subscription goes silent after a `chmod`: the file is still
              // there as far as the last revision knows, so the absent-file
              // recheck never runs either. Re-checking costs one stat, and an
              // unchanged revision emits nothing.
              name === directoryName,
          ),
          Stream.debounce(WATCH_DEBOUNCE),
        );

        const absentFileRechecks = Stream.fromSchedule(Schedule.spaced(ABSENT_FILE_RECHECK)).pipe(
          Stream.mapEffect(() => Ref.get(lastRevision)),
          Stream.filter((revision) => revision === null),
        );

        const baseline = Stream.fromEffect(nextEvent);
        const changes = Stream.merge(directoryChanges, absentFileRechecks).pipe(
          Stream.mapEffect(() => nextEvent),
        );

        // A null means this check found nothing the subscription had not
        // already reported, so it produces no event.
        return Stream.concat(baseline, changes).pipe(
          Stream.filter((event): event is ProjectFileWatchEvent => event !== null),
        );
      }),
    );

  return WorkspaceFileWatcher.of({ watchFile });
});

export const layer = Layer.effect(WorkspaceFileWatcher, make);
