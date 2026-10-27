// @effect-diagnostics nodeBuiltinImport:off - A one-shot git maintenance script.
/**
 * Deletes the native mobile paths and native-only `patchedDependencies` an upstream merge brought back
 * (ADR-008). Run it from the repository root after `git merge upstream/main`, conflicts or not.
 * `git rm --force` is required: a merge stages what it brings in, and `git rm` refuses staged content
 * that differs from HEAD. These paths are deleted on purpose, so nothing worth keeping is lost.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import {
  isRemovedNativeMobilePath,
  pruneNativeMobileJobNeeds,
  pruneNativeMobileBuilds,
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

// REGRESSION: Deleted native jobs remained in Check.needs and prevented every CI job from starting.
const CI_FILE = ".github/workflows/ci.yml";
const ciYaml = NodeFS.readFileSync(CI_FILE, "utf8");
if (/^<{7} /m.test(ciYaml)) {
  process.stdout.write(
    `${CI_FILE} still has conflict markers: resolve it, then run this script again.\n`,
  );
  process.exitCode = 1;
} else {
  const prunedCiYaml = pruneNativeMobileJobNeeds(ciYaml);
  if (prunedCiYaml !== ciYaml) {
    NodeFS.writeFileSync(CI_FILE, prunedCiYaml);
    git(["add", "--", CI_FILE]);
  }
}

const WORKSPACE_FILE = "pnpm-workspace.yaml";
const workspaceYaml = NodeFS.readFileSync(WORKSPACE_FILE, "utf8");
let removedPatchEntries = 0;
if (/^<{7} /m.test(workspaceYaml)) {
  process.stdout.write(
    `${WORKSPACE_FILE} still has conflict markers: resolve it, then run this script again to prune its native patch entries.\n`,
  );
  process.exitCode = 1;
} else {
  const pruned = pruneNativeMobilePatches(pruneNativeMobileBuilds(workspaceYaml));
  removedPatchEntries = pruned.removedPatchFiles.length;
  if (pruned.text !== workspaceYaml) {
    NodeFS.writeFileSync(WORKSPACE_FILE, pruned.text);
    const trackedPatchFiles = pruned.removedPatchFiles.filter((file) => trackedPaths.has(file));
    if (trackedPatchFiles.length > 0) git(["rm", "-q", "--force", "--", ...trackedPatchFiles]);
    git(["add", "--", WORKSPACE_FILE]);
  }
}

process.stdout.write(
  `Removed ${removedPaths.length} native mobile path(s) and ${removedPatchEntries} native patch entr${removedPatchEntries === 1 ? "y" : "ies"} (ADR-008).\n`,
);
