import {
  type KeybindingCommand,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingRule,
  MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
  type ResolvedKeybindingsConfig,
  THREAD_JUMP_KEYBINDING_COMMANDS,
  type ModelPickerJumpKeybindingCommand,
  type ThreadJumpKeybindingCommand,
} from "@t3tools/contracts";
import {
  isMacPlatform,
  matchesKeybindingShortcut,
  matchesKeybindingShortcutModifiers,
  normalizeEventKey,
  resolveEventKeys,
  type ShortcutEventLike,
  type ShortcutModifierStateLike,
} from "@t3tools/shared/keybindings";
import { diagnoseUnhandledKeybinding } from "./commands/unhandledKeybinding";
import { isElectron } from "./env";
import { projectScriptIdFromCommand } from "./projectScripts";
import { getFocusedPane, isSidebarSearchFocused, type PaneId } from "./lib/paneFocus";
// Type only, so nothing from the component graph is pulled in at runtime.
// The direction union stays where upstream declares it.
import type { ThreadTraversalDirection } from "./components/Sidebar.logic";
import { isFileManagerOpen } from "~/components/files/mesuraFileManager/isFileManagerOpen";
import { isDictationLive } from "~/dictation/dictationSessionStore";

export type { ShortcutEventLike, ShortcutModifierStateLike } from "@t3tools/shared/keybindings";
export { shortcutKeyFromEvent } from "@t3tools/shared/keybindings";

export interface ShortcutMatchContext {
  terminalFocus: boolean;
  terminalOpen: boolean;
  previewFocus: boolean;
  previewOpen: boolean;
  isWeb: boolean;
  isDesktop: boolean;
  editableFocus?: boolean;
  /**
   * Which pane owns the keyboard. Resolution fills each one lazily from the focus tree when
   * the caller leaves it out. The terminal drawer sets none: `terminalFocus` speaks for it.
   */
  sidebarFocus?: boolean;
  chatFocus?: boolean;
  panelFocus?: boolean;
  /**
   * The sidebar holds the keyboard, and a letter typed into it is a letter.
   * Only the sidebar's bare-letter chords consult this.
   */
  sidebarSearchFocus?: boolean;
  [key: string]: boolean;
}

interface ShortcutMatchOptions {
  platform?: string;
  context?: Partial<ShortcutMatchContext>;
}

interface ResolvedShortcutLabelOptions extends ShortcutMatchOptions {
  platform?: string;
}

const TERMINAL_WORD_BACKWARD = "\u001bb";
const TERMINAL_WORD_FORWARD = "\u001bf";
const TERMINAL_LINE_START = "\u0001";
const TERMINAL_LINE_END = "\u0005";
const TERMINAL_DELETE_TO_LINE_START = "\u0015";
/**
 * Fork export: the key half of a shortcut match, without the modifiers, for
 * callers that track a held chord (`AccountLimitsPanel.logic.ts`). The
 * matching itself lives in `@t3tools/shared/keybindings`.
 */
export function matchesShortcutKey(
  event: ShortcutEventLike,
  shortcut: KeybindingShortcut,
): boolean {
  return resolveEventKeys(event).has(shortcut.key);
}

/** Fork export: a full shortcut match, for callers that hold one binding (`usePaneNavigation`). */
export function matchesShortcut(
  event: ShortcutEventLike,
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): boolean {
  return matchesKeybindingShortcut(event, shortcut, platform);
}
function resolvePlatform(options: ShortcutMatchOptions | undefined): string {
  return options?.platform ?? navigator.platform;
}

const PANE_CONTEXT_KEYS = [
  ["sidebarFocus", "sidebar"],
  ["chatFocus", "chat"],
  ["panelFocus", "panel"],
] as const satisfies ReadonlyArray<readonly [string, PaneId]>;

function resolveContext(options: ShortcutMatchOptions | undefined): ShortcutMatchContext {
  const context: ShortcutMatchContext = {
    terminalFocus: false,
    terminalOpen: false,
    previewFocus: false,
    previewOpen: false,
    isWeb: !isElectron,
    isDesktop: isElectron,
    editableFocus: false,
    sidebarFocus: false,
    chatFocus: false,
    panelFocus: false,
    sidebarSearchFocus: false,
    ...options?.context,
  };

  // Read the document at most once, and only when a `when` clause asks for a pane: this runs
  // on every keystroke, Neovim insert mode included, against a 16.7 ms budget. A pane the
  // caller named itself keeps the caller's value.
  let focusedPane: PaneId | null | undefined;
  const isFocused = (pane: PaneId): boolean => {
    if (focusedPane === undefined) focusedPane = getFocusedPane();
    return focusedPane === pane;
  };

  for (const [key, pane] of PANE_CONTEXT_KEYS) {
    if (options?.context !== undefined && key in options.context) continue;
    Object.defineProperty(context, key, {
      get: () => isFocused(pane),
      enumerable: true,
      configurable: true,
    });
  }

  // Mesura dictation: the mode keys exist only while a recording or the last stopped job is
  // live. Read for every caller, so a dock that matches its own chord (Alt+S, the Hosts peek)
  // sees the dictation rule claim it.
  if (options?.context === undefined || !("dictationActive" in options.context)) {
    Object.defineProperty(context, "dictationActive", {
      get: isDictationLive,
      enumerable: true,
      configurable: true,
    });
  }

  // Separately memoised from the pane read above, and asked far less often:
  // only the sidebar's two bare letters carry a `when` clause that mentions
  // it, and both have already had to match `sidebarFocus` to get here.
  if (options?.context === undefined || !("sidebarSearchFocus" in options.context)) {
    let searchFocus: boolean | undefined;
    Object.defineProperty(context, "sidebarSearchFocus", {
      get: () => {
        if (searchFocus === undefined) searchFocus = isSidebarSearchFocused();
        return searchFocus;
      },
      enumerable: true,
      configurable: true,
    });
  }

  return context;
}

function evaluateWhenNode(node: KeybindingWhenNode, context: ShortcutMatchContext): boolean {
  switch (node.type) {
    case "identifier":
      if (node.name === "true") return true;
      if (node.name === "false") return false;
      return Boolean(context[node.name]);
    case "not":
      return !evaluateWhenNode(node.node, context);
    case "and":
      return evaluateWhenNode(node.left, context) && evaluateWhenNode(node.right, context);
    case "or":
      return evaluateWhenNode(node.left, context) || evaluateWhenNode(node.right, context);
  }
}

function matchesWhenClause(
  whenAst: KeybindingWhenNode | undefined,
  context: ShortcutMatchContext,
): boolean {
  if (!whenAst) return true;
  return evaluateWhenNode(whenAst, context);
}

export function shortcutConflictKey(
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): string {
  const useMetaForMod = isMacPlatform(platform);
  const metaKey = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const ctrlKey = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);
  return [
    shortcut.key,
    metaKey ? "meta" : "",
    ctrlKey ? "ctrl" : "",
    shortcut.shiftKey ? "shift" : "",
    shortcut.altKey ? "alt" : "",
  ].join("|");
}

function shortcutForContext(binding: ResolvedKeybindingRule, context: ShortcutMatchContext) {
  const shortcut = binding.shortcut;
  // Resolve persisted Mod+Enter against send preference without rewriting saved shortcuts.
  if (
    context.composerRequiresModifier &&
    binding.command === "composer.sendAlternate" &&
    shortcut.key === "enter" &&
    shortcut.modKey &&
    !shortcut.metaKey &&
    !shortcut.ctrlKey &&
    !shortcut.altKey &&
    !shortcut.shiftKey
  ) {
    return { ...shortcut, shiftKey: true };
  }
  return shortcut;
}

export function effectiveShortcutsForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
  options?: ShortcutMatchOptions,
): KeybindingShortcut[] {
  const platform = resolvePlatform(options);
  const context = resolveContext(options);
  const claimedShortcuts = new Set<string>();
  const effective: KeybindingShortcut[] = [];

  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (!binding) continue;
    if (!matchesWhenClause(binding.whenAst, context)) continue;

    const shortcut = shortcutForContext(binding, context);
    const conflictKey = shortcutConflictKey(shortcut, platform);
    if (claimedShortcuts.has(conflictKey)) {
      continue;
    }

    claimedShortcuts.add(conflictKey);
    if (binding.command === command) {
      effective.push(shortcut);
    }
  }

  return effective;
}

/**
 * Never ask this, or `shortcutLabelForCommand`, about a `pane.*` command: a pane command can
 * share its chord on purpose (`pane.focusDown` sits behind `terminal.toggle` on `mod+j`), and
 * this scan gives a shared chord to the last claimant. `lib/usePaneNavigation.ts` dispatches them.
 */
export function findEffectiveShortcutForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
  options?: ShortcutMatchOptions,
): KeybindingShortcut | null {
  return effectiveShortcutsForCommand(keybindings, command, options)[0] ?? null;
}

function matchesCommandShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
  options?: ShortcutMatchOptions,
): boolean {
  return resolveShortcutCommand(event, keybindings, options) === command;
}

/**
 * The last binding in `bindings` that this event satisfies, or null; last wins so a later
 * rule overrides an earlier one. The pane handler passes only the pane bindings, so it shares
 * this loop instead of copying it.
 */
export function findLastMatchingBinding(
  event: ShortcutEventLike,
  bindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): ResolvedKeybindingsConfig[number] | null {
  const platform = resolvePlatform(options);
  const context = resolveContext(options);

  for (let index = bindings.length - 1; index >= 0; index -= 1) {
    const binding = bindings[index];
    if (!binding) continue;
    // Shortcut first: it is arithmetic on the event, and a `when` clause can read the focus tree.
    // Saved Mod+Enter follows the send preference to Mod+Shift+Enter, as its label does, or it
    // steals foreground sends and loses to queue steering.
    if (!matchesShortcut(event, shortcutForContext(binding, context), platform)) continue;
    if (!matchesWhenClause(binding.whenAst, context)) continue;
    // The file-manager stand-down lives here because `usePaneNavigation` calls this directly;
    // one level up, pane chords would fire over the file manager in the capture phase. It
    // yields null instead of searching on, so a lower binding cannot inherit the claimed key.
    return standDownForFileManager(binding.command) === null ? null : binding;
  }
  return null;
}

export function resolveShortcutCommand(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): KeybindingCommand | null {
  const command = findLastMatchingBinding(event, keybindings, options)?.command ?? null;
  if (command !== null) diagnoseUnhandledKeybinding(event, command);
  return command;
}

/**
 * Fork: while the file manager is open, every host chord but its toggle stands down, so its
 * keys (`Ctrl+O` above all) reach its dispatcher. Every window listener resolves through
 * `findLastMatchingBinding`, so the one guard there covers them all.
 */
function standDownForFileManager(command: KeybindingCommand): KeybindingCommand | null {
  if (command === "fileTree.miller") return command;
  return isFileManagerOpen() ? null : command;
}

export function resolveChatShortcutCommand(
  event: ShortcutEventLike,
  primaryKeybindings: ResolvedKeybindingsConfig,
  activeKeybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): KeybindingCommand | null {
  const primaryCommand = resolveShortcutCommand(event, primaryKeybindings, options);
  if (primaryCommand !== null && projectScriptIdFromCommand(primaryCommand) === null) {
    return primaryCommand;
  }

  const activeCommand = resolveShortcutCommand(event, activeKeybindings, options);
  return activeCommand !== null && projectScriptIdFromCommand(activeCommand) !== null
    ? activeCommand
    : null;
}

export function formatShortcutKeyLabel(key: string): string {
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  if (key === "escape") return "Esc";
  if (key === "arrowup") return "Up";
  if (key === "arrowdown") return "Down";
  if (key === "arrowleft") return "Left";
  if (key === "arrowright") return "Right";
  return key.slice(0, 1).toUpperCase() + key.slice(1);
}

export function formatShortcutLabel(
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): string {
  const keyLabel = formatShortcutKeyLabel(shortcut.key);
  const useMetaForMod = isMacPlatform(platform);
  const showMeta = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const showCtrl = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);
  const showAlt = shortcut.altKey;
  const showShift = shortcut.shiftKey;

  if (useMetaForMod) {
    return `${showCtrl ? "\u2303" : ""}${showAlt ? "\u2325" : ""}${showShift ? "\u21e7" : ""}${showMeta ? "\u2318" : ""}${keyLabel}`;
  }

  const parts: string[] = [];
  if (showCtrl) parts.push("Ctrl");
  if (showAlt) parts.push("Alt");
  if (showShift) parts.push("Shift");
  if (showMeta) parts.push("Meta");
  parts.push(keyLabel);
  return parts.join("+");
}

export function shortcutLabelForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand | null,
  options?: string | ResolvedShortcutLabelOptions,
): string | null {
  if (command === null) return null;
  const resolvedOptions =
    typeof options === "string"
      ? ({ platform: options } satisfies ResolvedShortcutLabelOptions)
      : options;
  const platform = resolvePlatform(resolvedOptions);
  const shortcut = findEffectiveShortcutForCommand(keybindings, command, resolvedOptions);
  return shortcut ? formatShortcutLabel(shortcut, platform) : null;
}

export function threadJumpCommandForIndex(index: number): ThreadJumpKeybindingCommand | null {
  return THREAD_JUMP_KEYBINDING_COMMANDS[index] ?? null;
}

export function threadJumpIndexFromCommand(command: string): number | null {
  const index = THREAD_JUMP_KEYBINDING_COMMANDS.indexOf(command as ThreadJumpKeybindingCommand);
  return index === -1 ? null : index;
}

export function threadTraversalDirectionFromCommand(
  command: string | null,
): ThreadTraversalDirection | null {
  if (command === "thread.previous") return "previous";
  if (command === "thread.next") return "next";
  if (command === "thread.previousPage") return "previous-page";
  if (command === "thread.nextPage") return "next-page";
  return null;
}

export function shouldShowThreadJumpHintsForModifiers(
  modifiers: ShortcutModifierStateLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  // Ghostty can write keys to the shell before window shortcuts run, regardless of the when clause.
  if (resolveContext(options).terminalFocus) {
    return false;
  }

  const platform = resolvePlatform(options);

  for (const command of THREAD_JUMP_KEYBINDING_COMMANDS) {
    const shortcut = findEffectiveShortcutForCommand(keybindings, command, options);
    if (!shortcut) continue;
    if (matchesKeybindingShortcutModifiers(modifiers, shortcut, platform)) {
      return true;
    }
  }

  return false;
}

export function modelPickerJumpCommandForIndex(
  index: number,
): ModelPickerJumpKeybindingCommand | null {
  return MODEL_PICKER_JUMP_KEYBINDING_COMMANDS[index] ?? null;
}

export function modelPickerJumpIndexFromCommand(command: string): number | null {
  const index = MODEL_PICKER_JUMP_KEYBINDING_COMMANDS.indexOf(
    command as ModelPickerJumpKeybindingCommand,
  );
  return index === -1 ? null : index;
}

export function isTerminalToggleShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return matchesCommandShortcut(event, keybindings, "terminal.toggle", options);
}

export function isTerminalSplitShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return matchesCommandShortcut(event, keybindings, "terminal.split", options);
}

export function isTerminalSplitVerticalShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return matchesCommandShortcut(event, keybindings, "terminal.splitVertical", options);
}

export function isTerminalNewShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return matchesCommandShortcut(event, keybindings, "terminal.new", options);
}

export function isTerminalCloseShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return matchesCommandShortcut(event, keybindings, "terminal.close", options);
}

export function isDiffToggleShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return matchesCommandShortcut(event, keybindings, "diff.toggle", options);
}

export function isOpenFavoriteEditorShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return (
    event.repeat !== true &&
    matchesCommandShortcut(event, keybindings, "editor.openFavorite", options)
  );
}

/**
 * Whether the keypress should bold text in the rich-text composer: Mod+B
 * without extra modifiers, with text selected. Tiptap binds the same chord, so
 * app shortcuts captured ahead of the editor yield only in that case. With no
 * selection the chord stays with the app (the sidebar toggle by default).
 */
export function isRichTextBoldShortcut(
  event: ShortcutEventLike,
  selection: Pick<Selection, "isCollapsed"> | null,
): boolean {
  if (event.type !== undefined && event.type !== "keydown") {
    return false;
  }
  return (
    selection !== null &&
    !selection.isCollapsed &&
    resolveEventKeys(event).has("b") &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}

export function isTerminalClearShortcut(
  event: ShortcutEventLike,
  platform = navigator.platform,
): boolean {
  if (event.type !== undefined && event.type !== "keydown") {
    return false;
  }

  const key = event.key.toLowerCase();

  if (key === "l" && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    return true;
  }

  return (
    isMacPlatform(platform) &&
    key === "k" &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  );
}

export function terminalDeleteShortcutData(
  event: ShortcutEventLike,
  platform = navigator.platform,
): string | null {
  if (event.type !== undefined && event.type !== "keydown") {
    return null;
  }

  if (!isMacPlatform(platform)) {
    return null;
  }

  const key = normalizeEventKey(event.key);
  if (key !== "backspace") {
    return null;
  }

  return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    ? TERMINAL_DELETE_TO_LINE_START
    : null;
}

export function terminalNavigationShortcutData(
  event: ShortcutEventLike,
  platform = navigator.platform,
): string | null {
  if (event.type !== undefined && event.type !== "keydown") {
    return null;
  }

  if (event.shiftKey) return null;

  const key = normalizeEventKey(event.key);
  if (key !== "arrowleft" && key !== "arrowright") {
    return null;
  }

  const moveWord = key === "arrowleft" ? TERMINAL_WORD_BACKWARD : TERMINAL_WORD_FORWARD;
  const moveLine = key === "arrowleft" ? TERMINAL_LINE_START : TERMINAL_LINE_END;

  if (isMacPlatform(platform)) {
    if (event.altKey && !event.metaKey && !event.ctrlKey) {
      return moveWord;
    }
    if (event.metaKey && !event.altKey && !event.ctrlKey) {
      return moveLine;
    }
    return null;
  }

  if (event.ctrlKey && !event.metaKey && !event.altKey) {
    return moveWord;
  }

  if (event.altKey && !event.metaKey && !event.ctrlKey) {
    return moveWord;
  }

  return null;
}
