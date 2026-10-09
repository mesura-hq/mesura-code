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
    ["request.cited = onCite("],
  );
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
