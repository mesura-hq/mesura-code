// @effect-diagnostics nodeBuiltinImport:off - reads repository files as an external consumer.
/**
 * `scripts/release-smoke.ts` rebuilds the lockfile in a fixture that copies only the
 * workspace manifests it lists. A workspace package that another package depends on
 * but that the list omits fails the smoke with ERR_PNPM_WORKSPACE_PKG_NOT_FOUND, and
 * only in CI: `packages/keys` did exactly that. This guard fails locally instead.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { readWorkspacePackages } from "../../scripts/lib/mesura-checks.ts";

const repositoryRoot = NodePath.resolve(import.meta.dirname, "..", "..");

it("lists every depended-on workspace package in the release smoke's manifest fixture", () => {
  const smokeSource = NodeFS.readFileSync(
    NodePath.join(repositoryRoot, "scripts/release-smoke.ts"),
    "utf8",
  );
  // Only the fixture list: the file names the same manifests again in later assertions.
  const fixtureList =
    /const workspaceFiles = \[([\s\S]*?)\] as const;/u.exec(smokeSource)?.[1] ?? "";
  const listedManifests = new Set(
    [...fixtureList.matchAll(/^\s*"([^"]+\/package\.json)",/gmu)].map((match) => match[1]),
  );
  const packages = readWorkspacePackages(repositoryRoot);
  const dependedOn = new Set(packages.flatMap((entry) => [...entry.workspaceDependencies]));

  const missing = packages
    .filter((entry) => dependedOn.has(entry.name))
    .map((entry) => `${entry.directory}/package.json`)
    .filter((manifest) => !listedManifests.has(manifest));

  assert.isAbove(
    listedManifests.size,
    0,
    "found no `workspaceFiles` list in scripts/release-smoke.ts",
  );
  assert.deepStrictEqual(missing, [], "add these to `workspaceFiles` in scripts/release-smoke.ts");
});
