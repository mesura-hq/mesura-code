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
 * - The composer attach shortcut. ADR-003 kept `composer.attachFiles` on `alt+a`
 *   when the fork's attachment stack was retired, because upstream ships no
 *   keyboard route to attaching. The binding existing is not the same as the
 *   composer acting on it: a sync that rewrites the composer's shortcut handler
 *   leaves the chord resolving to a command nothing handles, while upstream's
 *   attach button keeps working and no suite notices.
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

it("handles the attach shortcut in the composer that owns the file input", () => {
  const composer = read("apps/web/src/components/chat/ChatComposer.tsx");
  assert.include(
    composer,
    'command === "composer.attachFiles"',
    "the composer no longer handles composer.attachFiles, so alt+a resolves to a command nothing acts on",
  );
  // The handler has to reach upstream's own input, which is the same element
  // the attach button clicks. Anything else would be a second attach route.
  // Delimited by the next branch rather than a character count, so growing the
  // comment above cannot silently move the assertions off the end of the window.
  const branchStart = composer.indexOf('command === "composer.attachFiles"');
  const branchEnd = composer.indexOf('command !== "composer.stash"', branchStart);
  assert.isAbove(
    branchEnd,
    branchStart,
    "the composer.stash branch that delimits this one is gone",
  );
  const body = composer.slice(branchStart, branchEnd);
  assert.include(
    body,
    "openAttachmentPicker()",
    "the attach shortcut no longer opens upstream's file input",
  );
  // Following the indirection rather than accepting it. The shortcut and the
  // footer button share this one helper, which is what makes a second attach
  // route impossible; a helper that stopped clicking the input would leave
  // both routes dead and the assertion above still passing.
  assert.match(
    composer,
    /const openAttachmentPicker = useCallback\(\(\) => \{\s*attachmentInputRef\.current\?\.click\(\);\s*\}, \[\]\);/,
    "openAttachmentPicker no longer clicks upstream's file input, so neither alt+a nor the attach button opens it",
  );
  // The chord must be claimed only once it will open the picker. Claiming it
  // first and returning afterwards swallows alt+a in every state where the
  // button is visible but the composer cannot act — a keystroke that goes
  // nowhere, which no behavioural test would notice.
  assert.isBelow(
    body.indexOf("return;"),
    body.indexOf("event.preventDefault()"),
    "the attach shortcut claims alt+a before deciding whether it can open the picker, so the keystroke can be swallowed with nothing opening",
  );
});

const THREAD_SORT_PERSISTENCE_CONSUMERS = [
  "apps/mobile/src/features/home/HomeRouteScreen.tsx",
  "apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx",
];

for (const consumer of THREAD_SORT_PERSISTENCE_CONSUMERS) {
  it(`persists the mobile thread sort order from ${consumer}`, () => {
    assert.include(
      read(consumer),
      "useThreadSortOrderPersistence({",
      `${consumer} no longer persists the thread sort order, so the picker works but the choice resets on the next cold start`,
    );
  });
}

it("keeps the mobile preference store out of home-list-options", () => {
  // Not a style rule. `home-list-options.ts` is imported by pure-function tests,
  // and the preference store pulls `react-native` in with it, which the test
  // runner cannot parse — moving the persistence hook into that module fails
  // home-list-options.test.ts and home-list-filter-menu.test.ts at collection.
  // That is why the hook lives in its own file; do not tidy it back in.
  const options = read("apps/mobile/src/features/home/home-list-options.ts");
  assert.notInclude(
    options,
    "state/preferences",
    "home-list-options.ts reaches the preference store, which drags react-native into modules that pure tests import",
  );
});

it("orders the active sidebar list through the fork's sort setting", () => {
  // This wiring was lost once already: upstream's v2 sidebar replaced #33's
  // recency ordering with a static anchor, and the setting kept existing while
  // nothing on that surface read it. The settings row and the command palette
  // both kept working, so no suite noticed.
  const sidebar = read("apps/web/src/components/Sidebar.tsx");
  assert.include(
    sidebar,
    "sortActiveThreadsForSidebar(active, sidebarThreadSortOrder)",
    "the sidebar sorts the active list without the thread sort setting, so #33's ordering is inert again",
  );
  assert.include(
    sidebar,
    "sidebarThreadSortOrder,\n    snoozeWakeTick,",
    "sidebarThreadSortOrder is missing from the memo's dependencies, so changing the setting does not re-sort the list",
  );
});

// The four footer controls are one row a user reads left to right, but nothing
// in a build or a behavioural test knows what order they belong in: each one
// renders correctly wherever it is put. The 2026-W35 sync moved upstream's
// attach button out of this group, which silently reordered the row and left
// the microphone separated from send. Asserting the order here is what makes
// that visible, and the group is the one place that decides it.
it("renders the composer footer controls in one group, in order", () => {
  const composer = read("apps/web/src/components/chat/ChatComposer.tsx");
  const groupStart = composer.indexOf("const ComposerFooterPrimaryActions = memo(");
  const groupEnd = composer.indexOf("export interface ChatComposerHandle", groupStart);
  assert.isAbove(groupStart, -1, "ComposerFooterPrimaryActions is gone, so nothing owns the order");
  assert.isAbove(groupEnd, groupStart, "the declaration that delimits the group is gone");
  const group = composer.slice(groupStart, groupEnd);

  const row = [
    ["context meter", "<ContextWindowMeter"],
    ["attach button", "props.showAttachControl"],
    ["dictation microphone", "props.dictationStartControl"],
    ["send button", "<ComposerPrimaryActions"],
  ] as const;

  let previousIndex = -1;
  let previousLabel = "the start of the group";
  for (const [label, marker] of row) {
    const index = group.indexOf(marker);
    assert.isAbove(index, -1, `the ${label} no longer renders inside ComposerFooterPrimaryActions`);
    assert.isAbove(
      index,
      previousIndex,
      `the composer footer reads ${label} before ${previousLabel}; the row must read context, attach, microphone, send`,
    );
    previousIndex = index;
    previousLabel = label;
  }
});
