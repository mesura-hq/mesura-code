// @effect-diagnostics nodeBuiltinImport:off - reads the repository index as an external consumer.
import * as NodeChildProcess from "node:child_process";

import { assert, it } from "vite-plus/test";

import {
  REMOVED_NATIVE_MOBILE_PREFIXES,
  isRemovedNativeMobilePath,
} from "../../scripts/lib/native-mobile-removal.ts";
import { repositoryRoot } from "./contractHarness.ts";

/**
 * This fork removed upstream's native mobile apps (ADR-008), and every upstream sync brings
 * some of their files back. A path that returns is not harmless: agents read it, the suite
 * runs it, and plans start adding native phases again. After a merge,
 * `node scripts/remove-native-mobile.ts` deletes them; this guard fails until it has run.
 */

it("tracks no file under a removed native mobile path", () => {
  const tracked = NodeChildProcess.execFileSync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((path) => path.length > 0);
  const returned = tracked.filter(isRemovedNativeMobilePath);
  assert.deepEqual(
    returned.slice(0, 20),
    [],
    `${returned.length} native mobile path(s) came back; run node scripts/remove-native-mobile.ts`,
  );
});

it("matches by prefix, so files upstream adds under a removed directory are caught too", () => {
  assert.isTrue(isRemovedNativeMobilePath("apps/mobile/src/new-upstream-screen.tsx"));
  assert.isTrue(isRemovedNativeMobilePath("scripts/mobile-new-upstream-tool.ts"));
  assert.isTrue(isRemovedNativeMobilePath(".github/workflows/mobile-new-lane.yml"));
  assert.isFalse(isRemovedNativeMobilePath("apps/web/src/mobile-layout.ts"));
  assert.isFalse(isRemovedNativeMobilePath("scripts/lib/native-mobile-removal.ts"));
  assert.isAbove(REMOVED_NATIVE_MOBILE_PREFIXES.length, 0);
});
