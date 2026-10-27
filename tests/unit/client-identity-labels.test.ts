// @effect-diagnostics nodeBuiltinImport:off - reads repository files as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { repositoryRoot } from "./contractHarness.ts";

/**
 * A client's self-reported label is where the fork's name reaches a server, a session list and
 * upstream's analytics; a new upstream file once brought "T3 Code Desktop" back with no conflict.
 * Each label is asserted at its producer, not by a string sweep, because the fork keeps upstream's
 * name where a rename is wrong: macOS and Windows artifact names, theme names, Clerk appearance keys.
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

it.each(LABEL_PRODUCERS)("names this fork in the client label $file reports", (producer) => {
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
