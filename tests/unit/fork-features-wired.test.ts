// @effect-diagnostics nodeBuiltinImport:off - reads repository files as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { repositoryRoot } from "./contractHarness.ts";

/**
 * Two fork features that a sync can leave present-but-unwired. Both happened
 * during the 2026-W35 merge and neither made a suite fail:
 *
 * - `/compact` on mobile. Upstream extracted the composer command menu into its
 *   own hook, and grafting the fork's native compaction into it passed a
 *   `hasThread` flag where the fork had computed "does this thread have a
 *   provider session". The command then offered itself on threads that had
 *   never started one.
 * - The sidebar project scope. Upstream replaced the fork's shared store with
 *   local component state, which left `projectScope.toggle` writing a store the
 *   sidebar no longer read — a keybinding that silently did nothing.
 *
 * Both are wiring rather than behaviour, which is why they are asserted at the
 * call site. A behavioural test would have passed in each case: the function
 * was right and the caller was wrong.
 */

const read = (relativePath: string) =>
  NodeFS.readFileSync(NodePath.join(repositoryRoot, relativePath), "utf8");

it("gates the mobile compact command on a real provider session", () => {
  const composer = read("apps/mobile/src/features/threads/ThreadComposer.tsx");
  const call = composer.slice(composer.indexOf("useComposerCommandMenu({"));
  assert.include(
    call.slice(0, 600),
    "hasExistingSession: props.selectedThread.session !== null",
    "the composer menu no longer derives hasExistingSession from the thread's session, so /compact can offer itself before one exists",
  );
});

it("keeps the sidebar project scope on the store the keybinding writes", () => {
  const sidebar = read("apps/web/src/components/Sidebar.tsx");
  assert.include(
    sidebar,
    "useProjectScopeStore((store) => store.projectScopeKey)",
    "the sidebar reads a local project scope again, so projectScope.toggle writes a store nothing reads",
  );
  assert.notInclude(
    sidebar,
    "const [projectScopeKey, setProjectScopeKey] = useState",
    "the sidebar holds project scope in local state, which the command palette's picker cannot reach",
  );
});
