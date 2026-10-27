// @effect-diagnostics nodeBuiltinImport:off - reads repository files as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { repositoryRoot } from "./contractHarness.ts";

/**
 * The file panel re-reads a file changed on disk through wiring unit tests cannot see: the panel
 * must call the hook, the mutation heuristic and refresh button must stay (the watcher replaces
 * neither), and the subscription family stays out of the shared client package.
 */

const read = (relativePath: string) =>
  NodeFS.readFileSync(NodePath.join(repositoryRoot, relativePath), "utf8");

it("watches the open file from the file panel", () => {
  const panel = read("apps/web/src/components/files/FilePreviewPanel.tsx");

  assert.include(
    panel,
    "useProjectFileWatch({",
    "the file panel no longer watches the open file, so a change on disk is invisible until something else refreshes it",
  );
});

it("keeps the mutation heuristic and the refresh button beside the watcher", () => {
  const panel = read("apps/web/src/components/files/FilePreviewPanel.tsx");

  assert.include(
    panel,
    "useWorkspaceMutationRefresh({",
    "the workspace mutation refresh was removed in favour of the watcher, but it also refreshes the tree",
  );
  assert.match(
    panel,
    /onRefreshSelectedFile: \(\) => \{\n\s*if \(!isDocument\) file\.refresh\(\);/,
    "the manual refresh button lost its handler, leaving no way out when the watcher is wrong",
  );
});

it("keeps the file-watch subscription out of the shared client package", () => {
  const shared = read("packages/client-runtime/src/state/runtime.ts");

  assert.notInclude(
    shared,
    "subscribeProjectFile",
    "the file-watch subscription family moved into the shared client package, which offers mobile a server watcher it never reads",
  );
});

it("reads changed files through the one existing read path", () => {
  const watch = read("apps/web/src/components/files/useProjectFileWatch.ts");

  // The event carries a revision and never contents, so the refresh has to go
  // back through `projects.readFile` — that is where truncation, binary
  // detection and the path-escape checks live.
  assert.notInclude(
    watch,
    "contents",
    "the watch hook started handling file contents itself, bypassing the read path that owns truncation and binary detection",
  );
});
