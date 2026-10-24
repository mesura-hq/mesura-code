// @effect-diagnostics nodeBuiltinImport:off - reads this process's own descriptors from /proc.
// Entry points: `makeAppendOnlyFileTail` and `watchAppendOnlyFile`, on real files in a temporary
// directory. The watch test waits on the watch's own signal, never on a sleep.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  TAIL_READ_MAX_BYTES,
  makeAppendOnlyFileTail,
  watchAppendOnlyFile,
  type AppendOnlyFileTail,
} from "./appendOnlyFileTail.ts";

const makeFile = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-append-only-tail-" });
  const directory = path.join(root, "run");
  yield* fileSystem.makeDirectory(directory);
  const filePath = path.join(directory, "events.jsonl");
  return {
    filePath,
    /** Deletes the file's directory and creates it again, empty. */
    recreateDirectory: fileSystem
      .remove(directory, { recursive: true })
      .pipe(Effect.andThen(fileSystem.makeDirectory(directory))),
    remove: fileSystem.remove(filePath),
    append: (text: string | Uint8Array) =>
      typeof text === "string"
        ? fileSystem.writeFileString(filePath, text, { flag: "a" })
        : fileSystem.writeFile(filePath, text, { flag: "a" }),
    replace: (text: string) => fileSystem.writeFileString(filePath, text),
  };
});

/**
 * Linux always has /proc/self/fd, so the descriptor tests never skip there;
 * elsewhere they run only where the platform provides one.
 */
const descriptorsObservable =
  // oxlint-disable-next-line t3code/no-global-process-runtime -- the skip decision needs the real host platform, outside any Effect runtime.
  process.platform === "linux" || NodeFS.existsSync("/proc/self/fd");

/** How many of this process's descriptors are open on `target`, and on it once deleted. */
const descriptorsOn = (target: string) => {
  // The kernel reports the resolved path, so resolve the directory the same way.
  const resolved = NodePath.join(
    NodeFS.realpathSync(NodePath.dirname(target)),
    NodePath.basename(target),
  );
  let live = 0;
  let deleted = 0;
  for (const descriptor of NodeFS.readdirSync("/proc/self/fd")) {
    let opened: string;
    try {
      opened = NodeFS.readlinkSync(`/proc/self/fd/${descriptor}`);
    } catch {
      continue; // The descriptor readdir itself used, closed already.
    }
    if (opened === resolved) live += 1;
    if (opened === `${resolved} (deleted)`) deleted += 1;
  }
  return { live, deleted };
};

/** Every complete line waiting, across as many reads as it takes. */
const readAll = (tail: AppendOnlyFileTail) =>
  Effect.gen(function* () {
    const lines: Array<string> = [];
    let reads = 0;
    while (true) {
      const read = yield* tail.read;
      reads += 1;
      lines.push(...read.lines);
      if (!read.more) return { lines, reads };
    }
  });

it.layer(NodeServices.layer)("append-only file tail", (it) => {
  describe("reading", () => {
    it.effect("an append-only tail holds a partial last line until its newline arrives", () =>
      Effect.gen(function* () {
        const file = yield* makeFile;
        const tail = yield* makeAppendOnlyFileTail(file.filePath);
        const accent = new TextEncoder().encode("é");

        yield* file.append("first\nsec");
        yield* file.append(accent.subarray(0, 1));
        expect((yield* tail.read).lines).toEqual(["first"]);

        // The second byte of the character arrives in a later write.
        yield* file.append(accent.subarray(1));
        yield* file.append("ond\n\nthird\n");
        const read = yield* tail.read;
        expect(read.lines).toEqual(["secéond", "third"]);
        expect(read.truncated).toBe(false);
        expect((yield* tail.read).lines).toEqual([]);
      }),
    );

    it.effect("an append-only tail reads a shrunk file again from its start and reports it", () =>
      Effect.gen(function* () {
        const file = yield* makeFile;
        const tail = yield* makeAppendOnlyFileTail(file.filePath);
        yield* file.append("one\ntwo\nthree\n");
        expect((yield* tail.read).lines).toEqual(["one", "two", "three"]);

        yield* file.replace("new\n");
        const read = yield* tail.read;
        expect(read.truncated).toBe(true);
        expect(read.lines).toEqual(["new"]);
      }),
    );

    it.effect(
      "an append-only tail reads a large file in bounded chunks without losing a line",
      () =>
        Effect.gen(function* () {
          const file = yield* makeFile;
          const tail = yield* makeAppendOnlyFileTail(file.filePath);
          const line = `${"x".repeat(99)}\n`;
          const count = Math.ceil((TAIL_READ_MAX_BYTES * 1.5) / line.length);
          yield* file.append(line.repeat(count));

          const { lines, reads } = yield* readAll(tail);
          expect(lines).toHaveLength(count);
          expect(reads).toBeGreaterThan(1);
        }),
    );

    it.effect("an append-only tail reads a replaced file from its start and reports it", () =>
      Effect.gen(function* () {
        const file = yield* makeFile;
        const tail = yield* makeAppendOnlyFileTail(file.filePath);
        yield* file.append("old\n");
        expect((yield* tail.read).lines).toEqual(["old"]);

        // A new file of the same size: only its identity tells it apart.
        yield* file.remove;
        yield* file.append("new\n");
        const read = yield* tail.read;
        expect(read.truncated).toBe(true);
        expect(read.lines).toEqual(["new"]);
      }),
    );

    it.effect(
      "an append-only tail reads a replacement with the same first line and length from its start",
      () =>
        Effect.gen(function* () {
          const file = yield* makeFile;
          const tail = yield* makeAppendOnlyFileTail(file.filePath);
          yield* file.append("same\nold-0\n");
          expect((yield* tail.read).lines).toEqual(["same", "old-0"]);

          // Neither the bytes read nor the size tell these files apart, and ext4
          // may give the new one the inode number the old one freed.
          for (const replacement of ["new-1", "new-2", "new-3"]) {
            yield* file.remove;
            yield* file.append(`same\n${replacement}\n`);
            const read = yield* tail.read;
            expect(read.truncated).toBe(true);
            expect(read.lines).toEqual(["same", replacement]);
          }
        }),
    );

    it.effect("an append-only tail of a missing file reads nothing and says so", () =>
      Effect.gen(function* () {
        const file = yield* makeFile;
        const tail = yield* makeAppendOnlyFileTail(file.filePath);
        expect(yield* tail.read).toEqual({
          lines: [],
          truncated: false,
          missing: true,
          more: false,
        });
        expect(tail.isMissing()).toBe(true);
      }),
    );
  });

  describe.skipIf(!descriptorsObservable)(
    "held descriptors, observed through /proc/self/fd (skipped only where the platform has none)",
    () => {
      it.effect("an append-only tail holds one descriptor on its file until its scope closes", () =>
        Effect.gen(function* () {
          const file = yield* makeFile;
          yield* file.append("one\n");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const tail = yield* makeAppendOnlyFileTail(file.filePath);
              expect(descriptorsOn(file.filePath).live).toBe(0);
              yield* tail.read;
              expect(descriptorsOn(file.filePath).live).toBe(1);
              // Later reads reuse the held descriptor rather than opening more.
              yield* file.append("two\n");
              expect((yield* tail.read).lines).toEqual(["two"]);
              expect(descriptorsOn(file.filePath).live).toBe(1);
            }),
          );
          expect(descriptorsOn(file.filePath)).toEqual({ live: 0, deleted: 0 });
        }),
      );

      it.effect(
        "an append-only tail releases a deleted file once another file appears at its path",
        () =>
          Effect.gen(function* () {
            const file = yield* makeFile;
            const tail = yield* makeAppendOnlyFileTail(file.filePath);
            yield* file.append("old\n");
            yield* tail.read;
            yield* file.remove;
            expect((yield* tail.read).missing).toBe(true);
            // Still held while the path is empty: its inode number stays taken.
            expect(descriptorsOn(file.filePath)).toEqual({ live: 0, deleted: 1 });

            yield* file.append("new\n");
            expect((yield* tail.read).lines).toEqual(["new"]);
            expect(descriptorsOn(file.filePath)).toEqual({ live: 1, deleted: 0 });
          }),
      );

      it.effect("an append-only tail releases a deleted file when its scope closes", () =>
        Effect.gen(function* () {
          const file = yield* makeFile;
          yield* Effect.scoped(
            Effect.gen(function* () {
              const tail = yield* makeAppendOnlyFileTail(file.filePath);
              yield* file.append("old\n");
              yield* tail.read;
              yield* file.remove;
              yield* tail.read;
              expect(descriptorsOn(file.filePath).deleted).toBe(1);
            }),
          );
          expect(descriptorsOn(file.filePath)).toEqual({ live: 0, deleted: 0 });
        }),
      );

      it.effect("an append-only file watch releases its directory when its scope closes", () =>
        Effect.gen(function* () {
          const file = yield* makeFile;
          const directory = NodePath.dirname(file.filePath);
          const tail = yield* makeAppendOnlyFileTail(file.filePath);
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.asVoid(watchAppendOnlyFile(tail));
              expect(descriptorsOn(directory).live).toBe(1);
            }),
          );
          expect(descriptorsOn(directory).live).toBe(0);
        }),
      );
    },
  );

  it.effect(
    "an append-only file watch recovers when its directory is deleted and created again",
    () =>
      Effect.gen(function* () {
        const file = yield* makeFile;
        const tail = yield* makeAppendOnlyFileTail(file.filePath);
        yield* file.append("first\n");
        const changes = yield* watchAppendOnlyFile(tail, {
          recheckInterval: Duration.millis(50),
        });
        expect((yield* tail.read).lines).toEqual(["first"]);
        const signals = yield* Queue.unbounded<void>();
        yield* changes.pipe(
          Stream.runForEach(() => Queue.offer(signals, undefined)),
          Effect.forkScoped,
        );

        yield* file.recreateDirectory;
        yield* file.append("second\n");
        yield* Queue.take(signals).pipe(Effect.timeout("2 seconds"));
        expect((yield* tail.read).lines).toEqual(["second"]);

        // Once the new directory is watched, a later append signals by itself.
        yield* Queue.clear(signals);
        yield* file.append("third\n");
        yield* Queue.take(signals).pipe(Effect.timeout("2 seconds"));
        expect((yield* tail.read).lines).toEqual(["third"]);
      }).pipe(TestClock.withLive),
  );

  it.effect("an append-only file watch signals a file that appears after the watch started", () =>
    Effect.gen(function* () {
      const file = yield* makeFile;
      const tail = yield* makeAppendOnlyFileTail(file.filePath);
      const changes = yield* watchAppendOnlyFile(tail);
      expect((yield* tail.read).missing).toBe(true);

      yield* file.append("run.started\n");
      const signal = yield* Stream.runHead(changes);

      expect(Option.isSome(signal)).toBe(true);
      expect((yield* tail.read).lines).toEqual(["run.started"]);
    }).pipe(TestClock.withLive),
  );
});
