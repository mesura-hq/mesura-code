import * as Option from "effect/Option";
import { assert, it } from "vite-plus/test";

import { resolveDesktopBaseDir } from "./DesktopStatePaths.ts";

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
