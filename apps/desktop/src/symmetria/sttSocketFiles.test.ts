import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  DIRECTORY_MODE,
  prepareSocketPath,
  removeSocketPath,
  restrictSocketPath,
  SOCKET_MODE,
  sttSocketPath,
} from "./sttSocketFiles.ts";

const withServices = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  effect.pipe(Effect.provide(NodeServices.layer));

// Acceptance: a Unix socket exists at a documented path. The prefix is ours and
// not the editor's, because both applications run at the same time.
it.effect("names the socket with its own prefix and the process id", () =>
  withServices(
    Effect.gen(function* () {
      const resolved = yield* sttSocketPath("/run/user/1000", 4242);

      assert.equal(resolved, "/run/user/1000/symmetria-mesura-4242.sock");
    }),
  ),
);

it.effect("creates the directory a socket path needs", () =>
  withServices(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const socketPath = path.join(dir, "nested", "stt.sock");

      yield* prepareSocketPath(socketPath);

      assert.isTrue(yield* fs.exists(path.dirname(socketPath)));
    }).pipe(Effect.scoped),
  ),
);

// Guard. `$XDG_RUNTIME_DIR` is already `drwx------`, so the socket's own mode
// is a second lock there. The `os.tmpdir()` fallback has no such parent, and a
// predictable name in a world-writable directory invites another local user to
// pre-place a symlink between the unlink and the bind. A directory we create
// must therefore be owner-only from the moment it exists.
it.effect("creates a directory of its own as owner-only", () =>
  withServices(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const created = path.join(dir, "fallback");
      const socketPath = path.join(created, "stt.sock");

      yield* prepareSocketPath(socketPath);

      const info = yield* fs.stat(created);
      const mode = Number(info.mode) & 0o777;
      assert.equal(mode, DIRECTORY_MODE, `expected 0700, got ${mode.toString(8)}`);
    }).pipe(Effect.scoped),
  ),
);

// A socket left by a process that was killed rather than stopped would fail the
// next bind with EADDRINUSE, so preparing the path clears it.
it.effect("clears a stale node left at the path", () =>
  withServices(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const socketPath = path.join(dir, "stt.sock");
      yield* fs.writeFileString(socketPath, "stale");

      yield* prepareSocketPath(socketPath);

      assert.isFalse(yield* fs.exists(socketPath));
    }).pipe(Effect.scoped),
  ),
);

// Acceptance: the socket is created with permissions that restrict it to the
// owning user. Anything able to write to it can put text in the composer and
// send it, so this is a criterion of the phase and not a later hardening pass.
it.effect("restricts the socket to the owning user", () =>
  withServices(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const socketPath = path.join(dir, "stt.sock");
      yield* fs.writeFileString(socketPath, "");

      yield* restrictSocketPath(socketPath);

      const info = yield* fs.stat(socketPath);
      const mode = Number(info.mode) & 0o777;
      assert.equal(mode, SOCKET_MODE, `expected 0600, got ${mode.toString(8)}`);
    }).pipe(Effect.scoped),
  ),
);

// Acceptance: the socket file is removed when the application exits.
it.effect("removes the socket file", () =>
  withServices(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const socketPath = path.join(dir, "stt.sock");
      yield* fs.writeFileString(socketPath, "");

      yield* removeSocketPath(socketPath);

      assert.isFalse(yield* fs.exists(socketPath));
    }).pipe(Effect.scoped),
  ),
);

// Teardown runs on paths that may already be gone — a bind that never happened
// leaves nothing to clean up, and that is the ordinary case, not a failure.
it.effect("treats removing an absent path as success", () =>
  withServices(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();

      yield* removeSocketPath(path.join(dir, "never-existed.sock"));

      assert.isTrue(true);
    }).pipe(Effect.scoped),
  ),
);
