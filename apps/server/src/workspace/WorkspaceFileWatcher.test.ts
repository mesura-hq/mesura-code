import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspaceFileWatcher from "./WorkspaceFileWatcher.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const FileSystemLayer = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspaceFileWatcher.layer.pipe(Layer.provide(FileSystemLayer))),
  Layer.provideMerge(FileSystemLayer),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-watch-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-workspace-watch-" });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

/**
 * Drives the watch stream into a queue so the test can take one event at a
 * time after each disk action, rather than sleeping and hoping.
 */
const watchIntoQueue = Effect.fn("watchIntoQueue")(function* (cwd: string, relativePath: string) {
  const watcher = yield* WorkspaceFileWatcher.WorkspaceFileWatcher;
  const queue = yield* Queue.unbounded<WorkspaceFileWatcher.ProjectFileWatchEventOut>();
  yield* Stream.runForEach(watcher.watchFile({ cwd, relativePath }), (event) =>
    Queue.offer(queue, event),
  ).pipe(Effect.orDie, Effect.forkScoped);
  return queue;
});

it.layer(TestLayer, { excludeTestServices: true })("WorkspaceFileWatcherLive", (it) => {
  describe("watchFile", () => {
    it.effect("emits one baseline event carrying the current revision", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "notes.md", "first");

        const queue = yield* watchIntoQueue(cwd, "notes.md");
        const baseline = yield* Queue.take(queue);

        expect(baseline.type).toBe("changed");
        if (baseline.type === "changed") {
          expect(baseline.relativePath).toBe("notes.md");
          expect(baseline.revision.length).toBeGreaterThan(0);
        }
      }),
    );

    it.effect("emits a changed event with a different revision after a write", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "notes.md", "first");

        const queue = yield* watchIntoQueue(cwd, "notes.md");
        const baseline = yield* Queue.take(queue);

        yield* writeTextFile(cwd, "notes.md", "second and longer");
        const afterWrite = yield* Queue.take(queue);

        expect(afterWrite.type).toBe("changed");
        if (baseline.type === "changed" && afterWrite.type === "changed") {
          expect(afterWrite.revision).not.toBe(baseline.revision);
        }
      }),
    );

    it.effect("emits changed once for a temp-file-plus-rename write", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "notes.md", "first");

        const queue = yield* watchIntoQueue(cwd, "notes.md");
        const baseline = yield* Queue.take(queue);

        // How editors and git actually replace a file: write a sibling, rename
        // it over the target. A watch on the file's own inode goes stale here.
        yield* writeTextFile(cwd, "notes.md.tmp", "replaced by rename");
        yield* fileSystem
          .rename(path.join(cwd, "notes.md.tmp"), path.join(cwd, "notes.md"))
          .pipe(Effect.orDie);

        const afterRename = yield* Queue.take(queue);
        expect(afterRename.type).toBe("changed");
        if (baseline.type === "changed" && afterRename.type === "changed") {
          expect(afterRename.revision).not.toBe(baseline.revision);
        }
      }),
    );

    it.effect("emits removed when the file disappears and changed when it returns", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "notes.md", "first");

        const queue = yield* watchIntoQueue(cwd, "notes.md");
        yield* Queue.take(queue);

        yield* fileSystem.remove(path.join(cwd, "notes.md")).pipe(Effect.orDie);
        const afterDelete = yield* Queue.take(queue);
        expect(afterDelete.type).toBe("removed");
        expect(afterDelete.relativePath).toBe("notes.md");

        yield* writeTextFile(cwd, "notes.md", "back again");
        const afterRecreate = yield* Queue.take(queue);
        expect(afterRecreate.type).toBe("changed");
      }),
    );

    it.effect("ignores writes to other files in the same directory", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "notes.md", "first");
        yield* writeTextFile(cwd, "other.md", "untouched");

        const queue = yield* watchIntoQueue(cwd, "notes.md");
        yield* Queue.take(queue);

        yield* writeTextFile(cwd, "other.md", "changed a neighbour");
        yield* writeTextFile(cwd, "notes.md", "changed the watched file");

        // The next event must be for the watched file, proving the neighbour's
        // write did not produce one of its own ahead of it.
        const next = yield* Queue.take(queue);
        expect(next.type).toBe("changed");
        expect(next.relativePath).toBe("notes.md");
      }),
    );

    it.effect("reports the normalised path, not the one the caller typed", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "notes.md", "first");

        // `readFile` answers with the normalised path, so a client correlating
        // watch events with reads by path needs the watcher to agree with it.
        const queue = yield* watchIntoQueue(cwd, "./notes.md");
        const baseline = yield* Queue.take(queue);

        expect(baseline.relativePath).toBe("notes.md");
      }),
    );

    it.effect(
      "recovers when the parent directory is deleted and recreated",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          yield* writeTextFile(cwd, "sub/notes.md", "first");

          const queue = yield* watchIntoQueue(cwd, "sub/notes.md");
          yield* Queue.take(queue);

          // Deleting the directory leaves the underlying watch inert: it stops
          // reporting and raises neither error nor close, so without the
          // absent-file recheck the subscription would go silent forever.
          yield* fileSystem.remove(path.join(cwd, "sub"), { recursive: true }).pipe(Effect.orDie);
          const afterDelete = yield* Queue.take(queue);
          expect(afterDelete.type).toBe("removed");

          yield* writeTextFile(cwd, "sub/notes.md", "back after the directory returned");
          const afterRecreate = yield* Queue.take(queue);
          expect(afterRecreate.type).toBe("changed");
        }),
      { timeout: 20_000 },
    );

    it.effect("fails for a path that escapes the workspace root", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir;
        const watcher = yield* WorkspaceFileWatcher.WorkspaceFileWatcher;

        const exit = yield* Stream.runHead(
          watcher.watchFile({ cwd, relativePath: "../outside.md" }),
        ).pipe(Effect.exit);

        expect(exit._tag).toBe("Failure");
      }),
    );
  });
});
