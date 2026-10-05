// @effect-diagnostics nodeBuiltinImport:off - reads the repository index as an external consumer.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import {
  REMOVED_NATIVE_MOBILE_PREFIXES,
  isRemovedNativeMobilePath,
  pruneNativeMobilePatches,
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

it("keeps no patch entry for a package only the native apps used", () => {
  const workspaceYaml = NodeFS.readFileSync(
    NodePath.join(repositoryRoot, "pnpm-workspace.yaml"),
    "utf8",
  );
  assert.deepEqual(
    pruneNativeMobilePatches(workspaceYaml).removedPatchFiles,
    [],
    "a native-only patch entry came back; run node scripts/remove-native-mobile.ts",
  );
});

it("prunes native patch entries by package name, with their comments, and keeps the rest exact", () => {
  // Upstream's block as a merge brings it back: a bumped version, a quoted scoped name and a
  // comment that belongs to the entry below it.
  const merged = [
    "packages:",
    "  - apps/*",
    "",
    "patchedDependencies:",
    '  "@effect/vitest@4.0.0-rc.112": patches/@effect__vitest@4.0.0-rc.112.patch',
    '  "@react-navigation/native-stack@7.18.0": patches/@react-navigation%2Fnative-stack@7.18.0.patch',
    "  # Preserve the final layout frame.",
    "  react-native-reanimated@4.6.0: patches/react-native-reanimated@4.6.0.patch",
    "  # Mesura: sharp omits `types` from its exports map.",
    "  sharp@0.35.0: patches/sharp@0.35.0.patch",
    "",
    "overrides:",
    "  react-native-reanimated@4.6.0: patches/not-a-patch-entry",
  ].join("\n");

  const pruned = pruneNativeMobilePatches(merged);

  assert.deepEqual(pruned.removedPatchFiles, [
    "patches/@react-navigation%2Fnative-stack@7.18.0.patch",
    "patches/react-native-reanimated@4.6.0.patch",
  ]);
  assert.equal(
    pruned.text,
    [
      "packages:",
      "  - apps/*",
      "",
      "patchedDependencies:",
      '  "@effect/vitest@4.0.0-rc.112": patches/@effect__vitest@4.0.0-rc.112.patch',
      "  # Mesura: sharp omits `types` from its exports map.",
      "  sharp@0.35.0: patches/sharp@0.35.0.patch",
      "",
      "overrides:",
      "  react-native-reanimated@4.6.0: patches/not-a-patch-entry",
    ].join("\n"),
  );
});
