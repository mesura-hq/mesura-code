// @effect-diagnostics nodeBuiltinImport:off - reads repository files as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { repositoryRoot } from "./contractHarness.ts";

/**
 * The modal key layer (docs/mesura/adr-009-modal-keys.md) lives in fork-owned
 * files: `packages/keys`, `apps/web/src/keys`, `apps/web/src/commands` and
 * `apps/web/src/lib/paneEdges.ts`. It reaches the app through small seams in
 * upstream files, and every weekly sync can drop one of them.
 *
 * A dropped seam leaves the layer present but unwired: the engine never
 * installs, a leader key runs a command nobody registers, `y` cites nothing,
 * PANE mode skips a border. The fork's own tests keep passing, because each
 * one exercises its module and not the upstream caller. So each seam is
 * asserted at its call site, as `fork-features-wired.test.ts` does.
 *
 * Assertions name calls and keys, never exact lines or formatting: every
 * source and every expected fragment is read as canonical tokens (comments
 * removed, whitespace kept only where it separates two words), so an upstream
 * reformat passes and a seam left behind in a comment fails. The seam list
 * comes from `git diff --name-only <branch base> -- apps packages`, filtered
 * to files with upstream history. `modal-keys-command-registry.test.ts`
 * checks that every leader command has some owner; the registry tests below
 * check that each upstream owner keeps its own `useCommandHandlers` block,
 * which a second owner of the same command would otherwise hide.
 */

/** Source text as tokens, and which characters belong to a string or regex literal. */
interface CanonicalSource {
  readonly text: string;
  readonly inLiteral: readonly boolean[];
}

const isWordCharacter = (character: string | undefined) =>
  character !== undefined && /[\w$]/.test(character);

/**
 * Removes comments and reduces whitespace to one space between two word
 * characters, keeping string, template and regex literals verbatim.
 *
 * A `'` or `"` literal ends at a line break when it is not closed, so an
 * apostrophe in JSX text spoils at most its own line.
 */
function canonicalize(source: string): CanonicalSource {
  let text = "";
  const inLiteral: boolean[] = [];
  let pendingSpace = false;
  const emit = (character: string, literal: boolean) => {
    if (pendingSpace && isWordCharacter(text.at(-1)) && isWordCharacter(character)) {
      text += " ";
      inLiteral.push(false);
    }
    pendingSpace = false;
    text += character;
    inLiteral.push(literal);
  };
  // The canonical text never ends in whitespace, so its last character is the
  // previous token's. Reads only the tail: a whole-text copy per `/` made the
  // largest sources take seconds.
  const regexMayStart = () =>
    text === "" ||
    "(,=:[!&|?{};".includes(text.at(-1)!) ||
    (text.endsWith("return") && !isWordCharacter(text.at(-7)));

  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    const next = source[index + 1];
    if (character === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
      pendingSpace = true;
    } else if (character === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      pendingSpace = true;
    } else if (character === '"' || character === "'" || character === "`") {
      emit(character, true);
      index += 1;
      while (index < source.length) {
        const inner = source[index]!;
        if (inner === "\n" && character !== "`") break;
        emit(inner, true);
        index += 1;
        if (inner === "\\" && index < source.length) {
          emit(source[index]!, true);
          index += 1;
        } else if (inner === character) break;
      }
    } else if (character === "/" && regexMayStart()) {
      emit(character, true);
      index += 1;
      let inClass = false;
      while (index < source.length && source[index] !== "\n") {
        const inner = source[index]!;
        emit(inner, true);
        index += 1;
        if (inner === "\\" && index < source.length) {
          emit(source[index]!, true);
          index += 1;
        } else if (inner === "[") inClass = true;
        else if (inner === "]") inClass = false;
        else if (inner === "/" && !inClass) break;
      }
    } else if (/\s/.test(character)) {
      pendingSpace = true;
      index += 1;
    } else {
      emit(character, false);
      index += 1;
    }
  }
  return { text, inLiteral };
}

/** A fragment in the same canonical form as the sources it is searched in. */
const tokens = (fragment: string) => canonicalize(fragment).text;

const readCanonical = (relativePath: string) =>
  canonicalize(NodeFS.readFileSync(NodePath.join(repositoryRoot, relativePath), "utf8"));

const read = (relativePath: string) => readCanonical(relativePath).text;

/** The canonical text between two markers, failing when either is gone. */
function region(source: string, startMarker: string, endMarker: string, file: string): string {
  const start = source.indexOf(tokens(startMarker));
  assert.isAbove(start, -1, `${file}: "${startMarker}" is gone`);
  const end = source.indexOf(tokens(endMarker), start + tokens(startMarker).length);
  assert.isAbove(end, start, `${file}: "${endMarker}" no longer follows "${startMarker}"`);
  return source.slice(start, end);
}

/** Every call to `callee` outside a comment or literal: where it is, and its argument text. */
function callArguments(
  source: CanonicalSource,
  callee: string,
): Array<{ index: number; text: string }> {
  const calls: Array<{ index: number; text: string }> = [];
  const pattern = new RegExp(`(?<![\\w$.])${callee}\\(`, "g");
  for (const match of source.text.matchAll(pattern)) {
    if (source.inLiteral[match.index]) continue;
    const open = match.index + match[0].length - 1;
    let depth = 0;
    for (let index = open; index < source.text.length; index += 1) {
      if (source.inLiteral[index]) continue;
      const character = source.text[index];
      if (character === "(") depth += 1;
      else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          calls.push({ index: match.index, text: source.text.slice(open + 1, index) });
          break;
        }
      }
    }
  }
  return calls;
}

/** Asserts that one call to `callee` in `file` carries every fragment. */
function assertCallCarries(file: string, callee: string, fragments: readonly string[]): void {
  const calls = callArguments(readCanonical(file), callee);
  assert.isAbove(calls.length, 0, `${file} no longer calls ${callee}`);
  const missing = fragments.filter(
    (fragment) => !calls.some((call) => call.text.includes(tokens(fragment))),
  );
  assert.deepEqual(missing, [], `${file}: ${callee} no longer carries these`);
}

/** Asserts that `file` registers each command in a `useCommandHandlers` block. */
function assertRegistersCommands(file: string, commands: readonly string[]): void {
  assertCallCarries(
    file,
    "useCommandHandlers",
    commands.map((command) => `"${command}":`),
  );
}

/**
 * The `{…}` block that opens after `marker`, braces included. Every brace
 * counts: the blocks this reads hold no unbalanced brace in a literal, and
 * `canonicalize`'s literal marks can drift in the largest sources.
 */
function blockAfter(source: string, marker: string, file: string): string {
  const text = canonicalize(source).text;
  const start = text.indexOf(tokens(marker));
  assert.isAbove(start, -1, `${file}: "${marker}" is gone`);
  const open = text.indexOf("{", start + tokens(marker).length);
  assert.isAbove(open, -1, `${file}: no block follows "${marker}"`);
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}" && --depth === 0) return text.slice(open, index + 1);
  }
  assert.fail(`${file}: the block after "${marker}" never closes`);
}

/** The class names of each element that carries `attribute`, in source order. */
function classNamesOf(source: string, attribute: string): string[][] {
  const parts = source.split(tokens(attribute));
  return parts.slice(0, -1).map((before, index) => {
    const element = before.slice(before.lastIndexOf("<"));
    const after = parts[index + 1]!;
    const tag = element + attribute + after.slice(0, after.indexOf(">"));
    return (/className="([^"]*)"/.exec(tag)?.[1] ?? "").split(" ").filter(Boolean);
  });
}

/** Whether a canonical source renders `<Name …>` or `<Name/>`. */
const rendersElement = (source: string, name: string) =>
  new RegExp(`<${name}(?![\\w$.])`).test(source);

// The matcher itself: a seam in a comment or a string is not a seam, and a
// reformat of a real one is still the same seam.

it("modal keys seam guard matcher: ignores calls in comments and strings", () => {
  const source = canonicalize(
    [
      "useEffect(() => {",
      "  return () => {}; /* subscribeChatCiteRequest((request) => request) */",
      "}, []);",
      "// installKeyEngine();",
      'const label = "subscribeChatCiteRequest(";',
    ].join("\n"),
  );
  assert.deepEqual(callArguments(source, "subscribeChatCiteRequest"), []);
  assert.deepEqual(callArguments(source, "installKeyEngine"), []);
  assert.notInclude(source.text, "installKeyEngine");
});

it("modal keys seam guard matcher: accepts formatting variants of a seam", () => {
  const spaced = canonicalize("installKeyEngine ( );");
  assert.lengthOf(callArguments(spaced, "installKeyEngine"), 1);

  const split = canonicalize(
    ["useCommandHandlers(", "  {", '    "thread.next"  :', "      next,", "  },", ");"].join("\n"),
  );
  const [call] = callArguments(split, "useCommandHandlers");
  assert.include(call?.text, tokens('"thread.next": next'));

  assert.isTrue(rendersElement(canonicalize("<>\n  <KeyEngineHost/>\n</>").text, "KeyEngineHost"));
  assert.isTrue(rendersElement(canonicalize("<KeyEngineHost />").text, "KeyEngineHost"));
  assert.isFalse(rendersElement(canonicalize("<KeyEngineHostLegacy />").text, "KeyEngineHost"));
});

it("modal keys seam guard matcher: an apostrophe in JSX text spoils only its line", () => {
  const source = canonicalize(
    ["<p>Don't panic</p>", "subscribeTurnJumpRequest((request) => onSelect(item));"].join("\n"),
  );
  assert.lengthOf(callArguments(source, "subscribeTurnJumpRequest"), 1);
});

// The engine and its host.

it("modal keys seam guard: main.tsx installs the key engine before the router exists", () => {
  const main = readCanonical("apps/web/src/main.tsx");
  const [install] = callArguments(main, "installKeyEngine");
  const [router] = callArguments(main, "getRouter");
  assert.isDefined(install, "main.tsx no longer calls installKeyEngine()");
  assert.isDefined(router, "main.tsx no longer calls getRouter()");
  // Its capture listener has to be registered before any component's, which
  // is what makes the engine see a key first.
  assert.isBelow(
    install!.index,
    router!.index,
    "installKeyEngine() runs after the router is built, so component listeners can register first",
  );
});

it("modal keys seam guard: main.tsx installs the Tab cancel", () => {
  const main = readCanonical("apps/web/src/main.tsx");
  assert.lengthOf(
    callArguments(main, "installNativeFocus"),
    1,
    "main.tsx no longer calls installNativeFocus(), so Tab walks the tab order again",
  );
});

it("modal keys seam guard: the chat route layout mounts KeyEngineHost", () => {
  const file = "apps/web/src/routes/_chat.tsx";
  const layout = region(read(file), "function ChatRouteLayout(", "</>", file);
  assert.isTrue(
    rendersElement(layout, "KeyEngineHost"),
    "ChatRouteLayout no longer mounts KeyEngineHost",
  );
});

it("modal keys seam guard: the vimMode setting is in the client schema and its patch", () => {
  const file = "packages/contracts/src/settings.ts";
  const settings = read(file);
  const schema = region(settings, "export const ClientSettingsSchema", "});", file);
  assert.include(schema, tokens("vimMode: Schema.Boolean"), "ClientSettingsSchema lost vimMode");
  const patch = region(settings, "export const ClientSettingsPatch", "});", file);
  assert.include(patch, tokens("vimMode: Schema.optionalKey"), "ClientSettingsPatch lost vimMode");
});

it("modal keys seam guard: Settings shows the Vim mode row and search finds it", () => {
  const file = "apps/web/src/components/settings/SettingsPanels.tsx";
  const typography = region(read(file), "function TypographySection(", "</SettingsSection>", file);
  assert.isTrue(
    rendersElement(typography, "VimModeRow"),
    "the Typography section no longer renders VimModeRow",
  );
  assert.include(
    read("apps/web/src/components/settings/settingsSearch.ts"),
    tokens('id: "vim-mode"'),
    "settings search no longer lists the Vim mode row",
  );
});

it("modal keys seam guard: the web package depends on @mesura/keys and @vimee/core", () => {
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(repositoryRoot, "apps/web/package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  assert.equal(manifest.dependencies?.["@mesura/keys"], "workspace:*");
  assert.isString(manifest.dependencies?.["@vimee/core"], "apps/web lost @vimee/core");
});

// The composer.

it("modal keys seam guard: the composer registers its Vim adapter", () => {
  assertCallCarries("apps/web/src/components/chat/ChatComposer.tsx", "registerComposerVimAdapter", [
    "read:",
    "write:",
    "setCursor:",
    "draftKey:",
  ]);
});

it("modal keys seam guard: a cite in Vim mode lands at the prompt's end and focuses the composer", () => {
  const file = "apps/web/src/components/chat/ChatComposer.tsx";
  // The implementation in the composer handle, not the handle type's declaration.
  const cite = region(
    read(file),
    "citeAssistantText: (citation, sourceAnchor) =>",
    "openModelPicker,",
    file,
  );
  assert.include(
    cite,
    tokens("getClientSettings().vimMode"),
    "citeAssistantText no longer branches on Vim mode",
  );
  // The composer taking focus is what puts the keys in insert mode after a cite.
  assert.notInclude(
    cite,
    tokens("focusEditor"),
    "the Vim mode cite passes a focus option, so it may no longer focus the composer",
  );
});

it("modal keys seam guard: a consumed draft clears the composer undo history", () => {
  const file = "apps/web/src/composerDraftStore.ts";
  // The implementation, not the store type's declaration of the same name.
  const clear = region(read(file), "clearComposerContent: (threadRef) =>", "set((state)", file);
  assert.include(
    clear,
    tokens("clearComposerUndoHistory("),
    "clearComposerContent no longer resets the Vim undo history, so u after a send restores the sent prompt",
  );
});

// The chat buffer.

it("modal keys seam guard: the selection toolbar answers cite requests", () => {
  assertCallCarries(
    "apps/web/src/components/chat/AssistantSelectionToolbar.tsx",
    "subscribeChatCiteRequest",
    ["request.cited = citeAndFlash(onCite,"],
  );
  // The Cite button cites through the same function, so it flashes the same way.
  assertCallCarries("apps/web/src/components/chat/AssistantSelectionToolbar.tsx", "citeAndFlash", [
    "selection.citation",
  ]);
});

it("modal keys seam guard: the timeline minimap answers turn jump requests", () => {
  assertCallCarries(
    "apps/web/src/components/chat/MessagesTimeline.tsx",
    "subscribeTurnJumpRequest",
    ["onSelect(item)", "request.rowId"],
  );
});

it("modal keys seam guard: assistant text reading stays exported for the chat buffer", () => {
  const selection = read("apps/web/src/lib/assistantTextSelection.ts");
  assert.include(selection, tokens("export function readAssistantText("));
  assert.include(selection, tokens("export type TextChunk"));
});

// Pane edges: the three usePaneEdge calls and what each one feeds.

it("modal keys seam guard: the terminal drawer's top edge is a pane edge", () => {
  const file = "apps/web/src/components/ThreadTerminalDrawer.tsx";
  assertCallCarries(file, "usePaneEdge", ['id: "terminal-drawer"', "resizeTo:", "reset:"]);
  // The drawer renders its handle in two branches; both must take the props.
  assert.isAtLeast(
    read(file).split(tokens("{...separatorProps}")).length - 1,
    2,
    "a terminal drawer handle no longer spreads separatorProps",
  );
});

it("modal keys seam guard: the right panel's left edge is a pane edge", () => {
  const file = "apps/web/src/components/preview/PreviewPanelShell.tsx";
  assertCallCarries(file, "usePaneEdge", ['id: "right-panel"', "resizeTo", "reset"]);
  assert.include(
    read(file),
    tokens("separatorProps={separatorProps}"),
    "PreviewPanelShell no longer hands separatorProps to its resize handle",
  );
  assert.include(
    read("apps/web/src/components/preview/RightPanelResizeHandle.tsx"),
    tokens("{...separatorProps}"),
    "RightPanelResizeHandle no longer spreads separatorProps",
  );
  assert.match(
    read("apps/web/src/hooks/useResizableWidth.ts"),
    /return\{[^}]*\bresizeTo\b[^}]*\breset\b[^}]*\}/,
    "useResizableWidth no longer returns resizeTo and reset",
  );
});

it("modal keys seam guard: the sidebar rail is a pane edge", () => {
  const file = "apps/web/src/components/ui/sidebar.tsx";
  assertCallCarries(file, "usePaneEdge", ['id: "sidebar"', "resizeTo", "onResetWidth"]);
  const sidebar = read(file);
  assert.include(
    sidebar,
    tokens("tabIndex={separatorProps.tabIndex}"),
    "the rail is no longer focusable",
  );
  assert.include(
    sidebar,
    tokens("onKeyDown={separatorProps.onKeyDown}"),
    "the rail ignores arrow keys",
  );
  assert.include(
    read("apps/web/src/components/AppSidebarLayout.tsx"),
    tokens("onResetWidth: resetSidebarWidth"),
    "AppSidebarLayout no longer passes the reset, so = in PANE mode does nothing on the sidebar",
  );
});

// The command registry: each upstream owner's block.

it("modal keys seam guard: the chat route registers new thread and preview", () => {
  assertRegistersCommands("apps/web/src/routes/_chat.tsx", [
    "chat.new",
    "chat.newLocal",
    "preview.toggle",
  ]);
});

it("modal keys seam guard: ChatView registers its thread and panel commands", () => {
  assertRegistersCommands("apps/web/src/components/ChatView.tsx", [
    "thread.copyReference",
    "thread.settle",
    "thread.pin",
    "thread.steerQueuedMessage",
    "terminal.toggle",
    "rightPanel.toggle",
    "rightPanel.close",
    "diff.toggle",
    "modelPicker.toggle",
    "composer.host",
    "composer.mode",
    "traitsPicker.toggle",
    "workspacePicker.toggle",
    "branchPicker.toggle",
    "question.toggleCollapse",
  ]);
});

it("modal keys seam guard: the composer registers attach and stash", () => {
  assertRegistersCommands("apps/web/src/components/chat/ChatComposer.tsx", [
    "composer.attachFiles",
    "composer.stash",
  ]);
});

it("modal keys seam guard: both sidebars register thread traversal", () => {
  for (const file of [
    "apps/web/src/components/Sidebar.tsx",
    "apps/web/src/components/LegacySidebar.tsx",
  ]) {
    assertRegistersCommands(file, ["thread.next", "thread.previous"]);
  }
});

it("modal keys seam guard: the sidebar control registers sidebar.toggle", () => {
  assertRegistersCommands("apps/web/src/components/AppSidebarLayout.tsx", ["sidebar.toggle"]);
});

it("modal keys seam guard: the open-in picker registers editor.openFavorite", () => {
  assertRegistersCommands("apps/web/src/components/chat/OpenInPicker.tsx", ["editor.openFavorite"]);
});

it("modal keys seam guard: the pull requests page registers its panel commands", () => {
  assertRegistersCommands("apps/web/src/routes/_chat.pull-requests.tsx", [
    "rightPanel.close",
    "rightPanel.toggle",
    "thread.copyReference",
  ]);
});

it("modal keys seam guard: the command palette registers its overlay toggles", () => {
  assertCallCarries("apps/web/src/components/CommandPalette.tsx", "useCommandHandlers", [
    "OVERLAY_MODE_BY_COMMAND",
    "toggleMode(mode)",
  ]);
});

it("modal keys seam guard: closing the palette returns to where Vim mode left", () => {
  const file = "apps/web/src/components/CommandPalette.tsx";
  const finalFocus = region(read(file), "finalFocus={", "}}", file);
  const restore = finalFocus.indexOf(tokens("restorePaletteOrigin()"));
  assert.isAbove(restore, -1, "the palette's finalFocus no longer calls restorePaletteOrigin()");
  assert.isBelow(
    restore,
    finalFocus.indexOf(tokens("focusAtEnd()")),
    "the palette focuses the composer before Vim mode can restore its origin",
  );
});

// Round 2: the sidebar keys, the right panel's tabs and launcher, one focus
// per surface, Ctrl+Q, and the terminal close confirmation. The cite flash is
// pinned above, with the selection toolbar.

/** How many times `fragment` occurs in a canonical source. */
const countOf = (source: string, fragment: string) => source.split(tokens(fragment)).length - 1;

it("modal keys seam guard round 2: the sidebar numbers and jumps to the threads on screen", () => {
  const file = "apps/web/src/components/Sidebar.tsx";
  assertCallCarries(file, "useViewportThreadKeys", ["showThreadJumpHints"]);
  assert.include(
    read(file),
    tokens("(viewportThreadKeys ?? orderedThreadKeys).entries()"),
    "the jump hints number the first nine threads of the list again, not the ones on screen",
  );
  assertCallCarries(file, "navigateToThreadKey", ["readViewportThreadKeys()"]);
  assert.include(
    read(file),
    tokens("[keybindings, orderedThreadKeys, viewportThreadKeys]"),
    "the jump hints no longer recompute when the threads on screen change",
  );
});

it("modal keys seam guard round 2: Ctrl+D and Ctrl+U scroll the sidebar without opening a thread", () => {
  const file = "apps/web/src/components/Sidebar.tsx";
  const pageKeys = region(
    read(file),
    'traversalDirection === "next-page" || traversalDirection === "previous-page"',
    "return;",
    file,
  );
  assert.include(
    pageKeys,
    tokens("scrollThreadList("),
    "the page keys no longer scroll the thread list, so they fall through to opening a thread",
  );
  // A scroll stops the key, and the branch returns whether or not the list
  // scrolled, so neither key ever reaches the thread traversal below it.
  const branch = blockAfter(
    read(file),
    'if (traversalDirection === "next-page" || traversalDirection === "previous-page")',
    file,
  );
  const scrolled = blockAfter(branch, "if (scrollThreadList(", file);
  for (const call of ["event.preventDefault()", "event.stopPropagation()"]) {
    assert.include(scrolled, tokens(call), `a page-key scroll no longer calls ${call}`);
  }
  // The branch's last statement is the return, after the scroll, whether or not it scrolled.
  assert.isTrue(
    branch.slice(branch.indexOf(scrolled) + scrolled.length).endsWith(tokens("return;}")),
    "the page-key branch no longer returns, so Ctrl+D or Ctrl+U opens a thread",
  );
});

it("modal keys seam guard round 2: arrows move over the sidebar rows and only Enter or Space opens one", () => {
  const file = "apps/web/src/components/Sidebar.tsx";
  const sidebar = readCanonical(file);
  assert.isAbove(
    callArguments(sidebar, "useThreadRowArrowKeys").length,
    0,
    "Sidebar no longer calls useThreadRowArrowKeys()",
  );
  // The arrow hook finds rows by this attribute: both row kinds carry it, and
  // both hand their keys to the row handler below.
  const rows = sidebar.text.split(tokens("data-mesura-thread-key={threadKey}")).slice(1);
  assert.lengthOf(
    rows,
    2,
    "the slim and card thread rows no longer both carry data-mesura-thread-key",
  );
  for (const row of rows) {
    const element = row.slice(0, row.indexOf("/>"));
    assert.include(
      element,
      tokens("onKeyDown={handleKeyDown}"),
      "a thread row lost its key handler",
    );
  }
  // The row the arrows reach looks hovered, in both row kinds.
  assert.isAtLeast(
    countOf(sidebar.text, "focus-visible:bg-sidebar-row-hover"),
    2,
    "a focused thread row no longer shows the hover background",
  );
  assert.include(
    sidebar.text,
    tokens("focus-visible:text-sidebar-foreground"),
    "a focused settled row no longer shows its title at full strength",
  );
  // An arrow reaching the row's own handler must not activate the thread.
  const handler = region(
    sidebar.text,
    "if (event.target !== event.currentTarget) return;",
    "onThreadActivate(threadRef)",
    file,
  );
  assert.include(
    handler,
    tokens('if (event.key !== "Enter" && event.key !== " ") return;'),
    "the thread row's key handler opens the thread on keys other than Enter and Space",
  );
});

it("modal keys seam guard round 2: the right panel walks its tabs and lands in the surface", () => {
  const file = "apps/web/src/components/RightPanelTabs.tsx";
  assertCallCarries(file, "useRightPanelTabCycling", [
    "tabBarRef: tabListRef",
    "surfaces: props.surfaces",
    "activeSurfaceId: props.activeSurfaceId",
    "onActivate: props.onActivate",
  ]);
  assertCallCarries(file, "usePanelSurfaceKeys", ["tabListRef", "props.activeSurfaceId"]);
});

it("modal keys seam guard round 2: the panel launcher takes its keys, opens on + and shows over the tabs", () => {
  const file = "apps/web/src/components/RightPanelTabs.tsx";
  const source = read(file);
  assertCallCarries(file, "registerLauncherKeyHandler", ["handler"]);
  const escape = region(source, 'if (event.key === "Escape" && launcherOpen)', "};", file);
  assert.include(
    escape,
    tokens("dismissPanelLauncher()"),
    "Escape no longer dismisses the launcher",
  );
  assert.include(
    source,
    tokens("onClick={openPanelLauncher}"),
    "the + button no longer opens the panel launcher",
  );
  // The overlay is drawn in the branch with open tabs, which stay mounted under it.
  const shown = region(source, "{props.children}", "</>", file);
  assert.include(
    shown,
    tokens("{launcherOpen ? ("),
    "the launcher no longer opens over the open tabs",
  );
  assert.isTrue(
    rendersElement(shown, "RightPanelEmptyState"),
    "the launcher is no longer drawn over the open tabs while launcherOpen",
  );
});

it("modal keys seam guard round 2: launcher rows close the launcher and keep focus in the panel", () => {
  const file = "apps/web/src/components/RightPanelTabs.tsx";
  const source = read(file);
  const runAction = region(source, "const runAction = (action: SurfaceAction) =>", "};", file);
  // The panel is read before the launcher closes, which can unmount the row.
  assert.include(
    runAction,
    tokens('const panel = rootRef.current?.closest("[data-preview-panel-mode]");'),
    "runAction no longer finds its panel, so focus is never kept in it",
  );
  for (const fragment of [
    "closePanelLauncher()",
    "action.onClick()",
    "if (panel) keepFocusInPanelAfterRender(panel)",
  ]) {
    assert.include(runAction, tokens(fragment), `runAction lost ${fragment}`);
  }
  // Every way to choose a surface row goes through runAction: a letter, Enter
  // on the highlight, and a click.
  const letters = region(
    source,
    "const handler = (event: KeyboardEvent): boolean =>",
    "registerLauncherKeyHandler(handler)",
    file,
  );
  for (const fragment of [
    "runPanelLauncherAction(chosen)",
    "reportUnavailable(chosen.label, chosen.disabledReason)",
    "current.runAction(chosen)",
  ]) {
    assert.include(letters, tokens(fragment), `the launcher's letter handler lost ${fragment}`);
  }
  // A browser profile is the Browser row with another target.
  assertCallCarries(file, "runAction", [
    "...action",
    "onClick: () => props.onAddBrowserInProfile(profile.id)",
  ]);
  const enter = region(source, 'if (event.key === "Enter")', 'if (event.key === "Escape"', file);
  assert.include(enter, tokens("runAction(action)"), "Enter on the launcher bypasses runAction");
  for (const fragment of [
    "onClick={() => runAction(action)}",
    "onClick={() => reportUnavailable(action.label, action.disabledReason)}",
  ]) {
    assert.include(source, tokens(fragment), `a launcher row lost ${fragment}`);
  }
  // A Panel action row runs its action whether it is available or shows why not.
  assert.equal(
    countOf(source, "onClick={() => runPanelLauncherAction(action)}"),
    2,
    "a Panel action row no longer runs its action",
  );
  // The Panel section: both launchers, the empty panel and the overlay, get the actions.
  assertCallCarries(file, "panelLauncherActions", ["hasActiveTab:", "maximized:"]);
  assert.equal(
    countOf(source, "panelActions={panelActions}"),
    2,
    "a launcher lost its Panel section",
  );
  assert.include(
    source,
    tokens("if (launcherOpen) rootRef.current?.focus({ preventScroll: true })"),
    "a launcher already mounted no longer takes the keys when it opens again",
  );
});

it("modal keys seam guard round 2: the launcher answers every letter and shows why a row cannot run", () => {
  const file = "apps/web/src/components/RightPanelTabs.tsx";
  const source = read(file);
  // The empty state's own launcher state and the actions it hands its letters.
  for (const fragment of [
    "panelActions?: readonly PanelLauncherAction[];",
    "const panelActions = props.panelActions ?? [];",
    "useRef({ actions, runAction, panelActions })",
    "shortcutActionsRef.current = { actions, runAction, panelActions };",
    "rootRef.current = node;",
  ]) {
    assert.include(source, tokens(fragment), `the launcher lost ${fragment}`);
  }
  assert.equal(
    countOf(source, "usePanelLauncherOpen()"),
    2,
    "the launcher or the tab bar no longer reads whether the launcher is open",
  );
  // Unavailable rows and Panel actions answer their letters; a key the page
  // already took is left alone.
  const letters = region(
    source,
    "const handler = (event: KeyboardEvent): boolean =>",
    "registerLauncherKeyHandler(handler)",
    file,
  );
  for (const fragment of [
    "if (event.defaultPrevented) return false;",
    "current.actions.map((entry) => ({ ...entry, available: true }))",
    "current.panelActions.map((entry) => ({ ...entry, available: true }))",
  ]) {
    assert.include(letters, tokens(fragment), `the launcher's letter handler lost ${fragment}`);
  }
  const unavailable = blockAfter(letters, "if (!chosen.available)", file);
  for (const call of [
    "closePanelLauncher()",
    "reportUnavailable(chosen.label, chosen.disabledReason)",
  ]) {
    assert.include(unavailable, tokens(call), `an unavailable row's letter no longer runs ${call}`);
  }
  assert.isTrue(
    unavailable.endsWith(tokens("return true;}")),
    "an unavailable row's letter no longer ends by taking the key",
  );
  const panelLetter = blockAfter(letters, "if (panelAction)", file);
  assert.include(
    panelLetter,
    tokens("runPanelLauncherAction(chosen)"),
    "a Panel action's letter no longer runs its action",
  );
  assert.isTrue(
    panelLetter.endsWith(tokens("return true;}")),
    "a Panel action's letter no longer ends by taking the key",
  );
  // The letters are read in the capture phase, ahead of app-level handlers,
  // and the key engine reaches the same handler.
  const registration = region(source, "registerLauncherKeyHandler(handler)", "}, []);", file);
  for (const fragment of [
    "const listener = (event: KeyboardEvent) => void handler(event);",
    'window.addEventListener("keydown", listener, true);',
    "unregister();",
    'window.removeEventListener("keydown", listener, true);',
  ]) {
    assert.include(
      registration,
      tokens(fragment),
      `the launcher's key registration lost ${fragment}`,
    );
  }
  const launcherRoot = region(source, "ref={focusOnMount}", "className=", file);
  assert.include(
    launcherRoot,
    tokens("data-key-passthrough"),
    "the key engine takes the launcher's letters again",
  );
  // A row that cannot run shows its reason on the row; no hover tooltip.
  assert.equal(
    countOf(source, "<UnavailableLauncherRow"),
    2,
    "a launcher section lost its unavailable rows",
  );
  for (const fragment of ["reason={action.disabledReason}", "reason={action.unavailableReason}"]) {
    assert.include(source, tokens(fragment), `an unavailable row lost ${fragment}`);
  }
  const row = region(source, "function UnavailableLauncherRow(", "</button>", file);
  for (const fragment of ['aria-disabled="true"', "onClick={props.onClick}", "{props.reason}"]) {
    assert.include(row, tokens(fragment), `UnavailableLauncherRow lost ${fragment}`);
  }
  // The Panel section under the surfaces.
  for (const fragment of [
    "panelActions.length > 0 ?",
    "panelActions.map((action) =>",
    "action.unavailableReason === null ?",
    ">Panel</h3>",
    "hasActiveTab: props.activeSurfaceId !== null",
    "maximized: props.maximized === true",
  ]) {
    assert.include(source, tokens(fragment), `the launcher's Panel section lost ${fragment}`);
  }
  // The launcher over the tabs is the empty panel's launcher: it takes the
  // same props, so a prop dropped from either, or added to one, fails here.
  const launchers = source
    .split("<RightPanelEmptyState")
    .slice(1)
    .map((rest) =>
      [...rest.slice(0, rest.indexOf("/>")).matchAll(/([\w$]+)=\{([^{}]*)\}/g)]
        .map(([attribute]) => attribute)
        .toSorted(),
    );
  assert.lengthOf(launchers, 2, "RightPanelTabs no longer renders the empty panel and the overlay");
  assert.isAtLeast(launchers[0]!.length, 20, "the empty panel's launcher lost its props");
  assert.deepEqual(
    launchers[1],
    launchers[0],
    "the launcher over the tabs and the empty panel's launcher take different props",
  );
  for (const prop of ["onAddFactory", "browserProfiles", "liveAgentCount", "panelActions"]) {
    assert.isTrue(
      launchers[0]!.some((attribute) => attribute.startsWith(`${prop}=`)),
      `the launchers lost ${prop}`,
    );
  }
  // The overlay covers the open tabs, positioned against the surface content.
  assert.isTrue(
    classNamesOf(source, "data-right-panel-surface-content").some((names) =>
      names.includes("relative"),
    ),
    "the surface content no longer positions the launcher overlay",
  );
  const overlay = region(source, "{launcherOpen ? (", "<RightPanelEmptyState", file);
  const overlayClasses = (/className="([^"]*)"/.exec(overlay)?.[1] ?? "").split(" ");
  for (const name of ["absolute", "inset-0", "z-20"]) {
    assert.include(overlayClasses, name, `the launcher overlay lost the ${name} class`);
  }
  // Upstream's drop-down menu behind the +, with its hover tooltips, is gone:
  // a merge that brings it back gives the panel two menus again.
  for (const removed of [
    "addSurfaceActions",
    "addSurfaceMenuOpen",
    "SurfaceMenuItem",
    "DisabledReasonTooltip",
    "SURFACE_DISABLED_REASONS",
  ]) {
    assert.notInclude(source, removed, `upstream's ${removed} is back beside the launcher`);
  }
});

it("modal keys seam guard round 2: ChatView registers maximize and the new-tab launcher", () => {
  const file = "apps/web/src/components/ChatView.tsx";
  assertRegistersCommands(file, ["rightPanel.toggleMaximized", "rightPanel.newTab"]);
  const newTab = blockAfter(read(file), '"rightPanel.newTab": () =>', file);
  // Opens the panel only when it is closed (a toggle would close an open one),
  // then the launcher in it.
  assert.match(
    newTab,
    /if\(!rightPanelOpen\)\{?toggleRightPanel\(\)/,
    "rightPanel.newTab no longer opens the panel only when it is closed",
  );
  const launcherAt = newTab.indexOf(tokens("openPanelLauncher()"));
  assert.isAbove(
    launcherAt,
    newTab.indexOf(tokens("toggleRightPanel()")),
    "rightPanel.newTab no longer opens the launcher after the panel",
  );
});

it("modal keys seam guard round 2: the desktop browser view hides under the panel launcher", () => {
  const file = "apps/web/src/components/preview/PreviewPanel.tsx";
  const source = readCanonical(file);
  assert.isAbove(
    callArguments(source, "usePanelLauncherOpen").length,
    0,
    "PreviewPanel no longer reads whether the launcher is open",
  );
  assert.include(
    source.text,
    tokens("visible={visible && !launcherOpen}"),
    "the native browser view stays visible over the panel launcher",
  );
});

it("modal keys seam guard round 2: the Diff panel and its file tree are pane entries", () => {
  assert.equal(
    countOf(read("apps/web/src/components/DiffPanel.tsx"), 'data-pane-entry="2"'),
    1,
    "the Diff code view is no longer the panel's second pane entry",
  );
  const file = "apps/web/src/components/diffs/DiffFileTree.tsx";
  assertCallCarries(file, "usePierreTreePaneEntry", ["model"]);
  const tree = read(file);
  for (const fragment of [
    "ref={bindPaneEntry}",
    'data-pane-entry="1"',
    "onKeyDown={onPaneEntryKeyDown}",
  ]) {
    assert.include(tree, tokens(fragment), `DiffFileTree lost ${fragment}`);
  }
});

it("modal keys seam guard round 2: every panel surface keeps its pane entries", () => {
  // File, the attribute value, and how many entries it renders.
  const entries: ReadonlyArray<readonly [string, string, number]> = [
    ["apps/web/src/components/AgentsPanel.tsx", 'data-pane-entry="1"', 2],
    ["apps/web/src/components/pullRequest/ThreadPullRequestsPanel.tsx", 'data-pane-entry="1"', 2],
    ["apps/web/src/components/pullRequest/PullRequestDetailPanel.tsx", 'data-pane-entry="1"', 1],
    ["apps/web/src/components/pullRequest/PullRequestCodeTab.tsx", 'data-pane-entry="2"', 1],
    ["apps/web/src/components/files/FilePreviewPanel.tsx", 'data-pane-entry="2"', 2],
    ["apps/web/src/components/files/AttachmentFilePreview.tsx", 'data-pane-entry="2"', 2],
  ];
  const lost = entries.flatMap(([file, entry, expected]) => {
    const found = countOf(read(file), entry);
    return found === expected ? [] : [`${file}: ${found} of ${expected} ${entry}`];
  });
  assert.deepEqual(lost, [], "a panel surface lost a keyboard entry");
  // An empty state has no scroll region to focus, so it is focusable itself.
  for (const file of [
    "apps/web/src/components/AgentsPanel.tsx",
    "apps/web/src/components/pullRequest/ThreadPullRequestsPanel.tsx",
  ]) {
    const source = read(file);
    const at = source.indexOf(tokens('data-pane-entry="1"'));
    const element = source.slice(source.lastIndexOf("<", at), source.indexOf(">", at));
    assert.include(
      element,
      tokens("tabIndex={-1}"),
      `${file}: the empty state's entry cannot take focus`,
    );
    assert.include(element, "outline-none", `${file}: the focused empty state draws an outline`);
  }
  assert.equal(
    countOf(
      read("apps/web/src/components/files/FilePreviewPanel.tsx"),
      "ref={previewFocusTargetRef}",
    ),
    2,
    "a file preview entry no longer takes previewFocusTargetRef",
  );
});

it("modal keys seam guard round 2: the Linux desktop app leaves Ctrl+Q to the page", () => {
  assert.include(
    read("apps/desktop/src/window/DesktopWindow.ts"),
    tokens('if (environment.platform !== "linux") quitShortcutHandler(event, input)'),
    "the quit guard runs on Linux again, so Ctrl+Q quits instead of closing a tab",
  );
  // apps/desktop/src/window/DesktopApplicationMenu.test.ts pins the menu itself.
  const file = "apps/desktop/src/window/DesktopApplicationMenu.ts";
  const linuxQuit = region(
    read(file),
    ': environment.platform === "linux"',
    '{ role: "quit" }',
    file,
  );
  // The click runs the quit through the app's Effect runtime, not a bare reference.
  for (const fragment of ['label: "Quit"', "click:", "runPromise(electronApp.quit)"]) {
    assert.include(linuxQuit, tokens(fragment), `the Linux Quit item lost ${fragment}`);
  }
  assert.notInclude(linuxQuit, tokens("accelerator"), "Linux Quit carries an accelerator again");
  assert.notInclude(linuxQuit, tokens('role: "quit"'), "Linux Quit takes the role and its Ctrl+Q");
});

it("modal keys seam guard round 2: a terminal close confirmation opens on Confirm", () => {
  assert.match(
    region(
      read("packages/contracts/src/ipc.ts"),
      "export interface ConfirmDialogOptions",
      "}",
      "packages/contracts/src/ipc.ts",
    ),
    /readonly initialFocus\?:"confirm";/,
    "ConfirmDialogOptions lost initialFocus",
  );
  assert.include(
    read("apps/web/src/lib/terminalCloseConfirm.ts"),
    tokens('initialFocus: "confirm"'),
    "closing a terminal no longer asks for focus on Confirm",
  );
  const store = read("apps/web/src/confirmDialog.ts");
  assert.include(
    store,
    tokens('focusConfirm: options?.initialFocus === "confirm"'),
    "the confirm dialog store drops the requested initial focus",
  );
  assert.include(
    store,
    tokens("...(pending.focusConfirm ? { focusConfirm: true } : {})"),
    "the shown confirmation no longer carries focusConfirm",
  );
  // Both places that show a confirmation build the state through confirmingState.
  assert.equal(
    countOf(store, "publish(confirmingState("),
    2,
    "a confirmation is shown without its focusConfirm",
  );
  for (const field of ["readonly focusConfirm?: boolean;", "readonly focusConfirm: boolean;"]) {
    assert.include(store, tokens(field), `the confirm dialog store lost ${field}`);
  }
  const host = read("apps/web/src/components/ConfirmDialogHost.tsx");
  for (const fragment of [
    'state.status === "confirming" && state.focusConfirm === true',
    "{...(focusConfirm ? { initialFocus: confirmButtonRef } : {})}",
    "ref={confirmButtonRef}",
  ]) {
    assert.include(host, tokens(fragment), `ConfirmDialogHost lost ${fragment}`);
  }
});

it("modal keys seam guard round 2: the panel commands and the Ctrl+Q defaults stay in the keybindings", () => {
  // apps/web/src/keybindings.test.ts tests resolution; this names the seams.
  const contractsFile = "packages/contracts/src/keybindings.ts";
  const commands = region(
    read(contractsFile),
    "export const STATIC_KEYBINDING_COMMANDS",
    "] as const;",
    contractsFile,
  );
  for (const command of ["rightPanel.nextTab", "rightPanel.previousTab", "rightPanel.newTab"]) {
    assert.include(commands, tokens(`"${command}"`), `STATIC_KEYBINDING_COMMANDS lost ${command}`);
  }

  const sharedFile = "packages/shared/src/keybindings.ts";
  const shared = read(sharedFile);
  const defaults = region(
    shared,
    "export const DEFAULT_KEYBINDINGS",
    "export const RETIRED_KEYBINDING_DEFAULTS",
    sharedFile,
  );
  for (const rule of [
    'key: "ctrl+q", command: "terminal.close", when: "terminalFocus"',
    'key: "ctrl+q", command: "rightPanel.close", when: "!terminalFocus"',
    'key: "ctrl+tab", command: "rightPanel.nextTab", when: "panelFocus && !terminalFocus"',
    'key: "ctrl+shift+tab", command: "rightPanel.previousTab", when: "panelFocus && !terminalFocus"',
    'key: "mod+t", command: "rightPanel.newTab", when: "panelFocus && !terminalFocus"',
  ]) {
    assert.include(defaults, tokens(rule), `DEFAULT_KEYBINDINGS lost ${rule}`);
  }
  const added = region(
    shared,
    "export const ADDED_KEYBINDING_DEFAULTS",
    "export const WITHDRAWN_KEYBINDING_DEFAULTS",
    sharedFile,
  );
  for (const id of ["2026-10-terminal-close-ctrl-q", "2026-10-right-panel-close-ctrl-q"]) {
    assert.include(added, tokens(`id: "${id}"`), `ADDED_KEYBINDING_DEFAULTS lost ${id}`);
  }
});
