import * as Option from "effect/Option";
import { assert, it } from "vite-plus/test";

import { resolveDesktopBaseDir, resolveDesktopStateDir } from "./DesktopStatePaths.ts";

// The function takes its own join, so the test supplies one rather than
// importing node:path — the assertion then does not depend on the host's
// path separator either.
const joinPath = (first: string, ...segments: ReadonlyArray<string>): string =>
  [first, ...segments].join("/");

it("defaults the desktop base directory to Mesura Code's own home", () => {
  const resolved = resolveDesktopBaseDir({
    homeDirectory: "/home/alice",
    joinPath,
    t3Home: Option.none(),
  });

  assert.equal(resolved, "/home/alice/.mesura-code");
});

it("uses the dev state subdirectory for a desktop checkout with the default home", () => {
  const t3Home = Option.none<string>();
  const baseDir = resolveDesktopBaseDir({ homeDirectory: "/home/alice", joinPath, t3Home });

  assert.equal(
    resolveDesktopStateDir({ baseDir, isDevelopment: true, joinPath, t3Home }),
    "/home/alice/.mesura-code/dev",
  );
});
