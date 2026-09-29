// Entry points: `makeAppendOnlyFileTail` and `watchAppendOnlyFile`, on real files in a temporary
// directory. The watch test waits on the watch's own signal, never on a sleep.
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
        const tail = makeAppendOnlyFileTail(file.filePath);
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
        const tail = makeAppendOnlyFileTail(file.filePath);
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
          const tail = makeAppendOnlyFileTail(file.filePath);
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
        const tail = makeAppendOnlyFileTail(file.filePath);
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

    it.effect("an append-only tail of a missing file reads nothing and says so", () =>
      Effect.gen(function* () {
        const file = yield* makeFile;
        const tail = makeAppendOnlyFileTail(file.filePath);
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

  it.effect(
    "an append-only file watch recovers when its directory is deleted and created again",
    () =>
      Effect.gen(function* () {
        const file = yield* makeFile;
        const tail = makeAppendOnlyFileTail(file.filePath);
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
      const tail = makeAppendOnlyFileTail(file.filePath);
      const changes = yield* watchAppendOnlyFile(tail);
      expect((yield* tail.read).missing).toBe(true);

      yield* file.append("run.started\n");
      const signal = yield* Stream.runHead(changes);

      expect(Option.isSome(signal)).toBe(true);
      expect((yield* tail.read).lines).toEqual(["run.started"]);
    }).pipe(TestClock.withLive),
  );
});
