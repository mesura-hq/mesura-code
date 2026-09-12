// @effect-diagnostics nodeBuiltinImport:off - reads repository files as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { repositoryRoot } from "./contractHarness.ts";

/**
 * A client that shows a thread reports it, so the server can tell somebody is
 * looking rather than that something is cached. The contract for that scope has
 * existed since before this fork and nothing ever emitted it, which is the
 * failure mode these assertions exist to catch: the declaration, the server
 * handling and the tests can all be present and correct while no route retains
 * anything, and every suite still passes.
 *
 * Asserted at the call site because that is where it breaks. Upstream rewrites
 * both route files, and a sync that drops one hook call leaves the scope silently
 * unemitted again — the hooks keep their unit tests, and the feature is gone.
 *
 * The mobile call site matters most: there is no emulator on this machine, so it
 * is the only check standing between that screen and an unnoticed regression.
 */

const read = (relativePath: string) =>
  NodeFS.readFileSync(NodePath.join(repositoryRoot, relativePath), "utf8");

it("retains the thread scope from the web thread route", () => {
  const route = read("apps/web/src/routes/_chat.$environmentId.$threadId.tsx");

  assert.include(
    route,
    "useThreadBackgroundScope(threadRef)",
    "the web thread route no longer retains a thread background scope, so the server cannot tell a browser is looking at a thread",
  );
});

it("retains the thread scope from the mobile thread screen", () => {
  const screen = read("apps/mobile/src/features/threads/ThreadRouteScreen.tsx");

  assert.include(
    screen,
    "useThreadBackgroundScope(",
    "the mobile thread screen no longer retains a thread background scope, and no emulator test covers this",
  );
});

it("keeps the thread scope off the routes that show no thread", () => {
  const draft = read("apps/web/src/routes/_chat.draft.$draftId.tsx");
  const pullRequests = read("apps/web/src/routes/_chat.pull-requests.tsx");

  assert.notInclude(
    draft,
    "useThreadBackgroundScope",
    "the draft route retains a thread scope, but a draft has no thread for the server to hold open",
  );
  assert.notInclude(
    pullRequests,
    "useThreadBackgroundScope",
    "the pull-requests route retains a thread scope, which would report a thread nobody is reading",
  );
});

it("routes the mobile subscription observer through the shared retain", () => {
  const scopes = read("apps/mobile/src/connection/background-activity-scopes.ts");
  const observer = scopes.slice(
    scopes.indexOf("export function observeMobileBackgroundActivitySubscription"),
  );

  assert.include(
    observer,
    "retainMobileBackgroundScope(",
    "the mobile subscription observer inlines its own ref-counting again, so subscription scopes and thread scopes no longer share one map",
  );
});
