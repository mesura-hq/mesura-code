// @effect-diagnostics nodeBuiltinImport:off - A one-shot git maintenance script.
/**
 * Deletes the native mobile paths an upstream merge brought back (ADR-008).
 *
 * Run it from the repository root after `git merge upstream/main`, conflicts or not:
 * `git rm` resolves a modify/delete conflict on these paths as a deletion, and also removes
 * files upstream added under them. It changes nothing when no such path is tracked.
 */
import * as NodeChildProcess from "node:child_process";

import { isRemovedNativeMobilePath } from "./lib/native-mobile-removal.ts";

const git = (args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

// `--stage` also lists unmerged entries, which a plain `ls-files` shows only once resolved.
const trackedPaths = new Set(
  git(["ls-files", "--stage", "-z"])
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.slice(entry.indexOf("\t") + 1)),
);
const removedPaths = [...trackedPaths].filter(isRemovedNativeMobilePath).sort();

if (removedPaths.length === 0) {
  process.stdout.write("No native mobile paths are tracked.\n");
} else {
  git(["rm", "-r", "-q", "--", ...removedPaths]);
  process.stdout.write(
    `Removed ${removedPaths.length} native mobile paths again (ADR-008).\n` +
      "Next: run `pnpm install`. If it fails with ERR_PNPM_UNUSED_PATCH, delete the patch entries it names from pnpm-workspace.yaml, and their files under patches/.\n",
  );
}
