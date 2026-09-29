import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as FactorySnapshotStore from "./FactorySnapshotStore.ts";

const sha256Hex = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

// Not valid UTF-8, with CRLF and a trailing space: the store keeps bytes, not text.
const planBytes = new Uint8Array([
  ...new TextEncoder().encode("# Plan: stored\r\n\r\n## Context \r\n"),
  0xff,
  0xfe,
  0x00,
]);

const makeTestLayer = () =>
  FactorySnapshotStore.layer.pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-factory-snapshot-store-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

/**
 * The store over a file system whose `exists` always answers false: every put then
 * reaches the publish step as a racing call does after another call published first.
 */
const makeRacingTestLayer = () =>
  FactorySnapshotStore.layer.pipe(
    Layer.provide(
      Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, (fileSystem) =>
          FileSystem.FileSystem.of({ ...fileSystem, exists: () => Effect.succeed(false) }),
        ),
      ),
    ),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-factory-snapshot-store-race-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

/** Every entry of the snapshots directory with its inode and modification time. */
const listSnapshots = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = (yield* fileSystem.readDirectory(config.factorySnapshotsDir)).toSorted();
  const entries: Array<{ name: string; ino: number | undefined; mtime: number | undefined }> = [];
  for (const name of names) {
    const info = yield* fileSystem.stat(path.join(config.factorySnapshotsDir, name));
    entries.push({
      name,
      ino: Option.getOrUndefined(info.ino),
      mtime: Option.getOrUndefined(info.mtime)?.getTime(),
    });
  }
  return entries;
});

describe("FactorySnapshotStore", () => {
  it.effect("stores the exact bytes under the snapshots directory, named by their sha256", () =>
    Effect.gen(function* () {
      const store = yield* FactorySnapshotStore.FactorySnapshotStore;
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const digest = yield* store.put(planBytes);

      expect(digest).toBe(sha256Hex(planBytes));
      expect(config.factorySnapshotsDir).toBe(path.join(config.stateDir, "factory-snapshots"));
      const stored = yield* fileSystem.readFile(path.join(config.factorySnapshotsDir, digest));
      expect([...stored]).toEqual([...planBytes]);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("writes nothing new when the same bytes are stored again", () =>
    Effect.gen(function* () {
      const store = yield* FactorySnapshotStore.FactorySnapshotStore;

      const first = yield* store.put(planBytes);
      const before = yield* listSnapshots;
      const second = yield* store.put(planBytes);
      const after = yield* listSnapshots;

      expect(second).toBe(first);
      // One file and no leftover temporary names; the same inode proves no rewrite.
      expect(before.map((entry) => entry.name)).toEqual([first]);
      expect(after).toEqual(before);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("keeps the first published snapshot when a racing put finds it at publish time", () =>
    Effect.gen(function* () {
      const store = yield* FactorySnapshotStore.FactorySnapshotStore;

      const first = yield* store.put(planBytes);
      const before = yield* listSnapshots;
      const second = yield* store.put(planBytes);
      const after = yield* listSnapshots;

      expect(second).toBe(first);
      // A rename would have replaced the file: a new inode. The temporary file is gone too.
      expect(before.map((entry) => entry.name)).toEqual([first]);
      expect(after).toEqual(before);
    }).pipe(Effect.provide(makeRacingTestLayer())),
  );

  it.effect("stores one file when many puts of the same bytes run concurrently", () =>
    Effect.gen(function* () {
      const store = yield* FactorySnapshotStore.FactorySnapshotStore;
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const digests = yield* Effect.all(
        Array.from({ length: 16 }, () => store.put(planBytes)),
        { concurrency: "unbounded" },
      );

      expect(new Set(digests)).toEqual(new Set([sha256Hex(planBytes)]));
      expect((yield* listSnapshots).map((entry) => entry.name)).toEqual([sha256Hex(planBytes)]);
      const stored = yield* fileSystem.readFile(
        path.join(config.factorySnapshotsDir, sha256Hex(planBytes)),
      );
      expect([...stored]).toEqual([...planBytes]);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("reads stored bytes back by digest", () =>
    Effect.gen(function* () {
      const store = yield* FactorySnapshotStore.FactorySnapshotStore;
      const digest = yield* store.put(planBytes);

      const read = yield* store.read(digest);

      expect([...read]).toEqual([...planBytes]);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("refuses a digest that is not 64 lowercase hex characters before touching a path", () =>
    Effect.gen(function* () {
      const store = yield* FactorySnapshotStore.FactorySnapshotStore;
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const digest = yield* store.put(planBytes);
      // A file that a digest-shaped lookup would find if the shape were not checked first.
      const uppercase = digest.toUpperCase();
      yield* fileSystem.writeFileString(
        path.join(config.factorySnapshotsDir, uppercase),
        "planted",
      );

      for (const candidate of [
        uppercase,
        digest.slice(0, 63),
        `${digest}0`,
        `../${digest}`,
        "../../state.sqlite",
        "",
      ]) {
        const error = yield* store.read(candidate).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "FactoryReadSnapshotError", reason: "invalid-digest" });
      }
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("reports not-found for a well-formed digest that was never stored", () =>
    Effect.gen(function* () {
      const store = yield* FactorySnapshotStore.FactorySnapshotStore;

      const error = yield* store.read("0".repeat(64)).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "FactoryReadSnapshotError", reason: "not-found" });
    }).pipe(Effect.provide(makeTestLayer())),
  );
});
