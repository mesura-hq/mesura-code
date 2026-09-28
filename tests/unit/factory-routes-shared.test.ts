// @effect-diagnostics nodeBuiltinImport:off - reads repository files as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { repositoryRoot } from "./contractHarness.ts";

/**
 * Phase 4 of factory-in-chat, acceptance criterion 8: web and Android build
 * the route defaults, the routing rules and the Approve message from one
 * shared module in `packages/client-runtime`.
 *
 * This reads source rather than behaviour because the failure it guards
 * against is invisible to a test that runs either client: a second copy of the
 * rules on one platform passes every behaviour spec on the day it is written,
 * and only drifts later. The behaviour itself is pinned by
 * `packages/client-runtime/src/factory/routes.test.ts` and
 * `planApproval.test.ts`, and by the two clients' card specs.
 *
 * Assertions are on substrings, never on counts.
 */

const read = (relativePath: string) =>
  NodeFS.readFileSync(NodePath.join(repositoryRoot, relativePath), "utf8");

const exists = (relativePath: string) =>
  NodeFS.existsSync(NodePath.join(repositoryRoot, relativePath));

/** Every non-test source file of a client directory, recursively. */
function clientSources(relativeDirectory: string): string[] {
  const root = NodePath.join(repositoryRoot, relativeDirectory);
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      const full = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$|test-support/.test(entry.name)) {
        found.push(NodePath.relative(repositoryRoot, full));
      }
    }
  };
  walk(root);
  return found;
}

const SHARED_ROUTES = "packages/client-runtime/src/factory/routes.ts";
const SHARED_APPROVAL = "packages/client-runtime/src/factory/planApproval.ts";
const CLIENT_FILES = {
  web: [
    "apps/web/src/factory/FactoryPlanCard.tsx",
    "apps/web/src/factory/FactoryRoutePicker.tsx",
    "apps/web/src/factory/useFactoryPlanApproval.ts",
  ],
  mobile: [
    "apps/mobile/src/features/factory/FactoryPlanCard.tsx",
    "apps/mobile/src/features/factory/FactoryRoutePicker.tsx",
    "apps/mobile/src/features/factory/useFactoryPlanApproval.ts",
  ],
} as const;

it("factory routes shared module is exported for both clients", () => {
  assert.isTrue(exists(SHARED_ROUTES), `${SHARED_ROUTES} exists`);
  assert.isTrue(exists(SHARED_APPROVAL), `${SHARED_APPROVAL} exists`);
  const manifest = JSON.parse(read("packages/client-runtime/package.json")) as {
    exports: Record<string, { default?: string }>;
  };
  const targets = Object.values(manifest.exports).map((entry) => entry.default);
  assert.include(targets, "./src/factory/routes.ts");
  assert.include(targets, "./src/factory/planApproval.ts");
});

it("factory routes web and android route pickers and approval hooks import the shared module", () => {
  for (const [client, files] of Object.entries(CLIENT_FILES)) {
    for (const file of files) {
      assert.isTrue(exists(file), `${client}: ${file} exists`);
    }
    const picker = read(files[1]);
    const approval = read(files[2]);
    assert.match(picker, /@t3tools\/client-runtime\/factory\/routes["']/, `${client} picker`);
    assert.match(
      approval,
      /@t3tools\/client-runtime\/factory\/plan-?[aA]pproval["']/,
      `${client} approval hook`,
    );
    // The card reads approvals through the shared module, or through its
    // approval hook, which the assertion above holds to the shared module.
    assert.match(
      read(files[0]),
      /@t3tools\/client-runtime\/factory\/plan-?[aA]pproval["']|["']\.\/useFactoryPlanApproval["']/,
      `${client} card reads approvals through the shared module`,
    );
  }
});

it("factory routes no client defines its own approval line, family defaults or budget", () => {
  const offenders: string[] = [];
  for (const file of [
    ...clientSources("apps/web/src/factory"),
    ...clientSources("apps/mobile/src/features/factory"),
  ]) {
    const source = read(file);
    if (source.includes("Approve plan sha256")) offenders.push(`${file}: approval line`);
    if (/["'`](opus|sol|luna)["'`]/.test(source)) offenders.push(`${file}: family literal`);
    if (/budgetUsd\s*[:=]\s*\d/.test(source)) offenders.push(`${file}: budget default`);
  }
  assert.deepEqual(offenders, []);
  assert.include(read(SHARED_APPROVAL), "Approve plan sha256");
});
