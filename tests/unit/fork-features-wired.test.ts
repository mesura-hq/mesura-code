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

function between(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.isAbove(start, -1, `the wiring owner "${startMarker}" is gone`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.isAbove(end, start, `the boundary "${endMarker}" after "${startMarker}" is gone`);
  return source.slice(start, end);
}

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
  const chatView = read("apps/web/src/components/ChatView.tsx");
  const composer = read("apps/web/src/components/chat/ChatComposer.tsx");
  const shortcuts = read("apps/web/src/components/chat/useChatShortcuts.ts");
  const commands = read("apps/web/src/components/chat/composerShortcuts.ts");
  const attachButton = read("apps/web/src/components/chat/ComposerAttachmentStrip.tsx");

  assert.match(
    between(chatView, "useChatShortcuts({", "fallback:"),
    /\bcomposerRef\s*,/,
    "the chat shortcut listener no longer receives the mounted composer's handle",
  );
  assert.match(
    chatView,
    /<ChatComposer\b[\s\S]*?composerRef=\{composerRef\}/,
    "ChatView no longer gives the shortcut listener the same handle as ChatComposer",
  );
  assert.include(
    shortcuts,
    'import { composerShortcutCommands } from "./composerShortcuts";',
    "the shortcut listener no longer imports the composer command map",
  );
  const dispatch = between(
    shortcuts,
    "const command = resolveChatShortcutCommand(",
    "const dismissFind =",
  );
  assert.include(
    dispatch,
    "composerShortcutCommands(input.composerRef, input.branchToolbarRef)[command]",
    "the normal chord listener no longer reaches the composer's attach command",
  );
  const claim = dispatch.indexOf("event.preventDefault()");
  const run = dispatch.indexOf("if (!run || run({ event, terminalFocusOwner }) === false) return;");
  assert.isAbove(run, -1, "an unavailable shortcut must return before claiming the event");
  assert.isAbove(
    claim,
    run,
    "the attach shortcut claims alt+a before deciding whether the picker opens",
  );
  assert.include(
    shortcuts,
    'window.addEventListener("keydown", onKeyDownCapture, true);',
    "the chat chord handler no longer listens for normal keyboard input",
  );
  assert.include(
    shortcuts,
    'window.removeEventListener("keydown", onKeyDownCapture, true);',
    "the chat chord handler no longer releases its listener",
  );
  const command = between(commands, '"composer.attachFiles":', '"modelPicker.toggle":');
  assert.match(
    command,
    /!event\.repeat && \(composerRef\.current\?\.openAttachmentPicker\(\) \?\? false\)/,
    "the attach chord must return the picker's result, including false for an absent handle",
  );

  assert.include(
    composer,
    "openAttachmentPicker: () => boolean;",
    "the composer handle no longer reports whether the attachment picker opened",
  );
  assert.match(
    composer,
    /useImperativeHandle\(\s*composerRef,\s*\(\) => \({\s*openAttachmentPicker,/,
    "the composer handle no longer exposes the same picker the registry uses",
  );
  assert.match(
    composer,
    /useCommandHandlers\(\{\s*"composer.attachFiles": openAttachmentPicker,/,
    "the registry no longer uses the chord's shared attachment picker",
  );
  const picker = between(
    composer,
    "const openAttachmentPicker = useStableCallback(",
    "useCommandHandlers({",
  );
  const unavailable = picker.match(/if\s*\(([\s\S]*?)\)\s*(?:\{\s*)?return false;/);
  assert.isNotNull(
    unavailable,
    "the picker no longer returns false when attachment is unavailable",
  );
  for (const guard of [
    "!showComposerAttachAction",
    "isCommandPaletteOpen()",
    "isComposerApprovalState",
    "projectSelectionRequired",
    "isRevertingCheckpoint",
  ]) {
    assert.include(unavailable![1], guard, `the attachment picker no longer checks ${guard}`);
  }
  assert.include(picker, "return false;", "an unavailable picker must leave the chord unclaimed");
  assert.match(
    picker,
    /composerFormRef\.current\?\.querySelector<HTMLButtonElement>\(\s*'\[aria-label="Attach files"\]'/,
    "the attach shortcut no longer reaches the visible upstream attach button",
  );
  const availability = picker.indexOf("if (!button || button.disabled) return false;");
  const click = picker.indexOf("button.click();");
  assert.isAbove(
    availability,
    -1,
    "the picker no longer rejects a missing or disabled attach button",
  );
  assert.isAbove(
    click,
    availability,
    "the picker clicks before checking the attach button's availability",
  );
  assert.isAbove(
    picker.indexOf("return true;"),
    click,
    "the picker reports success before clicking the button",
  );

  // Follow the button into its extracted owner. A live registry and a live
  // chord are insufficient if either stops reaching the one real file input.
  assert.match(
    composer,
    /const composerAttachButton = showComposerAttachAction \? \(\s*<ComposerAttachButton\s+addComposerAttachments=\{addComposerAttachments\}\s+focusComposer=\{focusComposer\}\s*\/>\s*\) : null;/,
    "the composer no longer mounts upstream's attach button with the shared attachment intake",
  );
  const buttonStart = attachButton.indexOf("export function ComposerAttachButton(");
  assert.isAbove(buttonStart, -1, "the extracted attachment button owner is gone");
  const button = attachButton.slice(buttonStart);
  assert.include(
    button,
    "const inputRef = useRef<HTMLInputElement>(null);",
    "the attach button loses its file input ref",
  );
  assert.match(
    button,
    /<input\s+ref=\{inputRef\}\s+type="file"\s+multiple/,
    "the attach button no longer owns upstream's multiple-file input",
  );
  assert.match(
    button,
    /onClick=\{\(\) => inputRef\.current\?\.click\(\)\}\s+aria-label="Attach files"/,
    "the shortcut's attach button no longer clicks that same file input",
  );
  assert.include(
    button,
    "const files = Array.from(event.currentTarget.files ?? []);",
    "the file input no longer reads its selected files",
  );
  assert.include(
    button,
    "void addComposerAttachments(files)",
    "the file input no longer sends its files to the composer's attachment intake",
  );
});

it("orders the active sidebar list through the fork's sort setting", () => {
  // This wiring was lost once already: upstream's v2 sidebar replaced #33's
  // recency ordering with a static anchor, and the setting kept existing while
  // nothing on that surface read it. The settings row and the command palette
  // both kept working, so no suite noticed.
  const sidebar = read("apps/web/src/components/Sidebar.tsx");
  const hook = between(sidebar, "function useSidebarThreads(", "function partitionSidebarThreads(");
  assert.include(
    hook,
    "useClientSettings((s) => s.sidebarThreadSortOrder)",
    "the active-list owner no longer subscribes to the fork's sort setting",
  );
  // One input object feeds both partitions: the project filter's and the search's,
  // which reaches past the filter (sidebarSearchScope.ts).
  const partitionCall = between(hook, "const partitionInput = {", "};");
  assert.include(
    hook,
    "const partition = partitionSidebarThreads(partitionInput);",
    "the active list is no longer partitioned from the shared input",
  );
  assert.match(
    partitionCall,
    /\bsidebarThreadSortOrder\s*,/,
    "the partition no longer receives the live sort setting",
  );
  assert.include(
    partitionCall,
    "clockKey: `${nowMinute}:${snoozeWakeTick}`",
    "the partition no longer receives snooze wake changes",
  );
  assert.notInclude(
    partitionCall,
    "=>",
    "the partition call became deferred; verify its memo dependencies before accepting this change",
  );
  assert.include(hook, "...partition,", "the sidebar hook no longer returns the sorted partition");
  const partition = between(
    sidebar,
    "function partitionSidebarThreads(",
    "function isOptimisticDropReleased(",
  );
  assert.include(
    partition,
    "sortActiveThreadsForSidebar(active, input.sidebarThreadSortOrder)",
    "the sidebar sorts the active list without the thread sort setting, so the setting is inert again",
  );
  assert.match(
    partition,
    /activeThreads:\s*optimisticDrop\?\.section[^?]*\? sortedActive\s*:/,
    "the partition no longer returns its sorted active list",
  );
  assert.match(
    sidebar,
    /activeThreads,[\s\S]*?\}\s*= useSidebarThreads\(\{/,
    "the sidebar no longer consumes the active list from its subscribed hook",
  );
  assert.include(
    sidebar,
    'const activeRows = rowsOf(activeThreads, "active");',
    "the active sidebar rows no longer use the sorted active list",
  );
  assert.include(
    sidebar,
    "items.push(...activeRows);",
    "the sorted active rows no longer enter the rendered list",
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
  // The right-hand footer now owns the order. The extracted primary component
  // supplies send, while the parent supplies context, attach and dictation.
  const group = between(composer, 'data-chat-composer-actions="right"', "</div>");

  const row = [
    ["context meter", "<ContextWindowMeter"],
    ["attach button", "{composerAttachButton}"],
    ["dictation microphone", "{dictationStartControl}"],
    ["send button", "<ComposerFooterPrimaryActions"],
  ] as const;

  let previousIndex = -1;
  let previousLabel = "the start of the group";
  for (const [label, marker] of row) {
    const index = group.indexOf(marker);
    assert.isAbove(index, -1, `the ${label} no longer renders inside the right-hand footer group`);
    assert.isAbove(
      index,
      previousIndex,
      `the composer footer reads ${label} before ${previousLabel}; the row must read context, attach, microphone, send`,
    );
    previousIndex = index;
    previousLabel = label;
  }
  assert.include(
    composer,
    'import { ComposerFooterPrimaryActions } from "./ComposerFooterControls";',
    "the footer no longer uses the extracted primary controls",
  );
  const primary = between(
    read("apps/web/src/components/chat/ComposerFooterControls.tsx"),
    "export const ComposerFooterPrimaryActions = memo(",
    "export function ComposerModelPicker(",
  );
  assert.include(primary, "<ComposerPrimaryActions", "the extracted footer no longer renders send");
  assert.include(
    group,
    "activeContextWindow={null}",
    "the extracted controls render a second context meter",
  );
  assert.include(
    group,
    "reserveContextWindowMeter={false}",
    "the extracted controls reserve another context slot",
  );
  assert.include(
    group,
    "onSubmitMessage={handleSubmitMessageStable}",
    "the footer no longer reaches submit",
  );
  assert.include(
    primary,
    "onSubmitMessage={props.onSubmitMessage}",
    "the extracted send control loses submit",
  );
  assert.include(
    read("apps/web/src/components/ChatView.tsx"),
    "dictationStartControl={<DictationStartButton />}",
    "ChatView no longer supplies the footer microphone",
  );
});
