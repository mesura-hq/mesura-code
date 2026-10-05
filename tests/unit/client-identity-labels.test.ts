// @effect-diagnostics nodeBuiltinImport:off - reads repository files as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { repositoryRoot } from "./contractHarness.ts";

/**
 * The label a client reports for itself is the one place this fork's name
 * reaches a server, a session list and upstream's analytics. During the
 * 2026-W35 sync upstream added a new file carrying "T3 Code Desktop" and
 * "T3 Code Web", and because the file was new it merged without a conflict —
 * nothing flagged it, every suite stayed green, and the fork silently started
 * calling itself T3 Code again.
 *
 * `mesura-identity.test.ts` guards the state-home literal rather than product
 * labels, so it does not cover this. These do.
 *
 * Each label is asserted at its producer rather than by sweeping for the string,
 * because the fork deliberately keeps upstream's name in places a rename would
 * be wrong: the macOS and Windows artifact names, upstream's theme names, and
 * the Clerk appearance keys.
 */

const LABEL_PRODUCERS = [
  {
    file: "apps/web/src/connection/clientMetadata.ts",
    labels: ["Mesura Code Desktop", "Mesura Code Web"],
  },
  {
    file: "apps/desktop/src/backend/DesktopLocalEnvironmentAuth.ts",
    labels: ["Mesura Code Desktop"],
  },
] as const;

const read = (relativePath: string) =>
  NodeFS.readFileSync(NodePath.join(repositoryRoot, relativePath), "utf8");

for (const producer of LABEL_PRODUCERS) {
  it(`names this fork in the client label ${producer.file} reports`, () => {
    const source = read(producer.file);
    for (const label of producer.labels) {
      assert.include(
        source,
        label,
        `${producer.file} no longer reports "${label}" — a sync replaced the fork's client label`,
      );
    }
    assert.notMatch(
      source,
      /"T3 Code (Desktop|Web|Mobile)"/,
      `${producer.file} reports a T3 Code client label, so this fork identifies itself as upstream`,
    );
  });
}
