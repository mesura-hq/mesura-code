// @effect-diagnostics nodeBuiltinImport:off - reads repository files as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { repositoryRoot } from "./contractHarness.ts";

/**
 * The file panel re-reads a file when it changes on disk. Three pieces of
 * wiring carry that, and each fails in a way the unit tests cannot see: the
 * decision function stays correct, the watcher keeps running on the server, and
 * the panel simply never hears about it.
 *
 * - The panel calls the hook. Upstream rewrites this file often and a sync that
 *   drops the call leaves freshness back where it started, with the refresh
 *   button as the only way to see an agent's edit.
 * - The mutation heuristic and the refresh button stay. The watcher is not a
 *   replacement for either: the heuristic also refreshes the tree, and the
 *   button is the way out when the watcher is wrong.
 * - The subscription family stays out of the shared client package. Defining it
 *   there would offer a server-side file watcher to mobile, which reads files
 *   without subscribing and has no use for one.
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
  assert.include(
    panel,
    "onRefreshSelectedFile: file.refresh",
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
