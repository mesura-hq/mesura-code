import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { sttSocketPath } from "./sttSocketFiles.ts";

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
