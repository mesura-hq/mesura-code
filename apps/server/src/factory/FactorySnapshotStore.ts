import { FactoryReadSnapshotError, isFactorySnapshotDigest } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

export class FactorySnapshotWriteError extends Schema.TaggedError<FactorySnapshotWriteError>()(
  "FactorySnapshotWriteError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not store the factory snapshot.";
  }
}

/**
 * Keeps the exact bytes of plans and reports the Software Factory presented,
 * one file per sha256 under the server's state directory. A digest always
 * names the same bytes, so a stored file is never rewritten and a reader may
 * cache it forever.
 */
export class FactorySnapshotStore extends Context.Service<
  FactorySnapshotStore,
  {
    /** Stores the bytes unless their digest is already stored; returns the digest. */
    readonly put: (bytes: Uint8Array) => Effect.Effect<string, FactorySnapshotWriteError>;
    /** Reads stored bytes. The digest's shape is checked before it touches a path. */
    readonly read: (digest: string) => Effect.Effect<Uint8Array, FactoryReadSnapshotError>;
  }
>()("t3/factory/FactorySnapshotStore") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const directory = config.factorySnapshotsDir;

  const put = Effect.fn("FactorySnapshotStore.put")(
    function* (bytes: Uint8Array) {
      const digest = yield* crypto.digest("SHA-256", bytes).pipe(Effect.map(Encoding.encodeHex));
      const target = path.join(directory, digest);
      if (yield* fileSystem.exists(target)) return digest;
      // Created on first use: a server that never sees a plan keeps no empty directory.
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      const uuid = yield* crypto.randomUUIDv4;
      const temporary = path.join(directory, `.${digest}.${uuid}.tmp`);
      // Written aside, then published with a hard link: a reader never sees a partial file,
      // and a link never replaces a target another call published first. A rename would.
      yield* fileSystem.writeFile(temporary, bytes);
      yield* fileSystem.link(temporary, target).pipe(
        Effect.catchIf(
          (cause) => cause.reason._tag === "AlreadyExists",
          () => Effect.void,
        ),
        Effect.ensuring(fileSystem.remove(temporary).pipe(Effect.ignore)),
      );
      return digest;
    },
    Effect.mapError((cause) => new FactorySnapshotWriteError({ cause })),
  );

  const read = Effect.fn("FactorySnapshotStore.read")(function* (digest: string) {
    if (!isFactorySnapshotDigest(digest)) {
      return yield* new FactoryReadSnapshotError({ reason: "invalid-digest", digest });
    }
    return yield* fileSystem.readFile(path.join(directory, digest)).pipe(
      Effect.mapError(
        (cause) =>
          new FactoryReadSnapshotError({
            reason: cause.reason._tag === "NotFound" ? "not-found" : "read-failed",
            digest,
            cause,
          }),
      ),
    );
  });

  return FactorySnapshotStore.of({ put, read });
});

export const layer = Layer.effect(FactorySnapshotStore, make);
