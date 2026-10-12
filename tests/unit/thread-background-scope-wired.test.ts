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
 * the chat layout and ThreadRouteView. A sync that drops one hook call leaves
 * the scope silently unemitted — the hooks keep their unit tests, and the
 * feature is gone.
 */

const read = (relativePath: string) =>
  NodeFS.readFileSync(NodePath.join(repositoryRoot, relativePath), "utf8");

it("retains the thread scope from the web thread route", () => {
  const layout = read("apps/web/src/routes/_chat.tsx");
  const view = read("apps/web/src/components/ThreadRouteView.tsx");

  assert.include(
    layout,
    "<ThreadRouteView target={threadTarget}",
    "the chat layout no longer mounts the view that retains the visible thread scope",
  );
  assert.include(
    view,
    'target.kind === "server" ? target.threadRef : (draftSession?.promotedTo ?? inferredThreadRef)',
    "the shared view no longer selects the server thread or a promoted draft thread",
  );

  assert.include(
    view,
    "useThreadBackgroundScope(serverThreadRef)",
    "the web thread route no longer retains a thread background scope, so the server cannot tell a browser is looking at a thread",
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
