// @effect-diagnostics nodeBuiltinImport:off - A one-shot git maintenance script.
/**
 * Deletes the native mobile paths an upstream merge brought back (ADR-008), and the
 * `patchedDependencies` entries in `pnpm-workspace.yaml` for packages only those apps used.
 *
 * Run it from the repository root after `git merge upstream/main`, conflicts or not:
 * `git rm` resolves a modify/delete conflict on these paths as a deletion, and also removes
 * files upstream added under them. It changes nothing when no such path is tracked.
 *
 * `--force` is required, not a shortcut: a merge stages every file it brings in, and `git rm`
 * refuses a path whose staged content differs from HEAD unless forced. These paths are being
 * deleted on purpose, so no content worth keeping is lost.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import {
  isRemovedNativeMobilePath,
  pruneNativeMobilePatches,
} from "./lib/native-mobile-removal.ts";

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

if (removedPaths.length > 0) git(["rm", "-r", "-q", "--force", "--", ...removedPaths]);

const WORKSPACE_FILE = "pnpm-workspace.yaml";
const workspaceYaml = NodeFS.readFileSync(WORKSPACE_FILE, "utf8");
let removedPatchEntries = 0;
if (/^<{7} /m.test(workspaceYaml)) {
  process.stdout.write(
    `${WORKSPACE_FILE} still has conflict markers: resolve it, then run this script again to prune its native patch entries.\n`,
  );
  process.exitCode = 1;
} else {
  const pruned = pruneNativeMobilePatches(workspaceYaml);
  removedPatchEntries = pruned.removedPatchFiles.length;
  if (removedPatchEntries > 0) {
    NodeFS.writeFileSync(WORKSPACE_FILE, pruned.text);
    const trackedPatchFiles = pruned.removedPatchFiles.filter((file) => trackedPaths.has(file));
    if (trackedPatchFiles.length > 0) git(["rm", "-q", "--force", "--", ...trackedPatchFiles]);
    git(["add", "--", WORKSPACE_FILE]);
  }
}

process.stdout.write(
  `Removed ${removedPaths.length} native mobile path(s) and ${removedPatchEntries} native patch entr${removedPatchEntries === 1 ? "y" : "ies"} (ADR-008).\n`,
);
