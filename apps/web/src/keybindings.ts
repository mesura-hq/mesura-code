import {
  type KeybindingCommand,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
  type ResolvedKeybindingsConfig,
  THREAD_JUMP_KEYBINDING_COMMANDS,
  type ModelPickerJumpKeybindingCommand,
  type ThreadJumpKeybindingCommand,
} from "@t3tools/contracts";
import { getFocusedPane, isSidebarSearchFocused, type PaneId } from "./lib/paneFocus";
// Type only, so nothing from the component graph is pulled in at runtime.
// The direction union stays where upstream declares it.
import type { ThreadTraversalDirection } from "./components/Sidebar.logic";
import { isFileManagerOpen } from "~/components/files/mesuraFileManager/isFileManagerOpen";
import { isDictationLive } from "~/dictation/dictationSessionStore";
import { isMacPlatform } from "./lib/utils";

export interface ShortcutEventLike {
  getModifierState?: (key: "AltGraph") => boolean;
  type?: string;
  code?: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface ShortcutModifierStateLike {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface ShortcutMatchContext {
  terminalFocus: boolean;
  terminalOpen: boolean;
  previewFocus: boolean;
  previewOpen: boolean;
  /**
   * Which pane owns the keyboard, filled from the document's focus tree for
   * every caller. A binding scoped to one pane says so with these rather
   * than by naming every pane it is not.
   *
   * The terminal drawer sets none of the three: it is its own pane, and
   * `terminalFocus` already speaks for it.
   */
  sidebarFocus: boolean;
  chatFocus: boolean;
  panelFocus: boolean;
  /**
   * The sidebar holds the keyboard, and a letter typed into it is a letter.
   * Only the sidebar's bare-letter chords consult this.
   */
  sidebarSearchFocus: boolean;
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
const EVENT_CODE_SHORTCUT_KEYS: Readonly<Record<string, string>> = {
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Digit0: "0",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
};

function normalizeEventKey(key: string): string {
  const normalized = key.toLowerCase();
  if (normalized === "esc") return "escape";
  return normalized;
}

export function shortcutKeyFromEvent(event: Pick<ShortcutEventLike, "key" | "code">): string {
  const layoutKey = normalizeEventKey(event.key);
  if (/^[a-z]$/.test(layoutKey)) return layoutKey;
  const physicalKey = event.code ? EVENT_CODE_SHORTCUT_KEYS[event.code] : undefined;
  return physicalKey ?? layoutKey;
}

function resolveEventKeys(event: ShortcutEventLike): Set<string> {
  const layoutKey = normalizeEventKey(event.key);
  const keys = new Set([layoutKey]);
  // The physical-position fallback exists for layouts that type non-Latin
  // letters (Cyrillic, Greek) and for Option-modified symbols on macOS.
  // When the layout already produces a Latin letter, match on it alone;
  // otherwise a remapped physical key triggers shortcuts for two different
  // letters at once and shadows system shortcuts on non-QWERTY layouts.
  const letterCode = event.code?.match(/^Key([A-Z])$/)?.[1];
  if (letterCode && !/^[a-z]$/.test(layoutKey)) {
    keys.add(letterCode.toLowerCase());
  }
  keys.add(shortcutKeyFromEvent(event));
  return keys;
}

function matchesShortcutModifiers(
  event: ShortcutModifierStateLike,
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): boolean {
  const useMetaForMod = isMacPlatform(platform);
  const expectedMeta = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const expectedCtrl = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);
  return (
    event.metaKey === expectedMeta &&
    event.ctrlKey === expectedCtrl &&
    event.shiftKey === shortcut.shiftKey &&
    event.altKey === shortcut.altKey
  );
}

export function matchesShortcutKey(
  event: ShortcutEventLike,
  shortcut: KeybindingShortcut,
): boolean {
  return resolveEventKeys(event).has(shortcut.key);
}

export function matchesShortcut(
  event: ShortcutEventLike,
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): boolean {
  if (
    !isMacPlatform(platform) &&
    event.getModifierState?.("AltGraph") &&
    !/^[a-z0-9]$/i.test(event.key)
  )
    return false;
  if (!matchesShortcutModifiers(event, shortcut, platform)) return false;
  return matchesShortcutKey(event, shortcut);
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
    sidebarFocus: false,
    chatFocus: false,
    panelFocus: false,
    sidebarSearchFocus: false,
    ...options?.context,
  };

  // The document is read only if a `when` clause actually asks which pane has
  // focus, and then once. This runs on every keystroke typed anywhere in the
  // app, including every one typed into the embedded Neovim editor, whose
  // insert-mode latency is measured against a 16.7 ms budget. Most keystrokes
  // never reach a pane-scoped rule and so never walk the DOM at all.
  //
  // A caller that named a pane itself keeps its own value: the property is
  // only replaced where the caller left it out.
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

/**
 * Never ask this, or `shortcutLabelForCommand`, about a `pane.*` command.
 *
 * A pane command may share its chord with another command on purpose, and
 * this scan awards a shared chord to the last binding that claims it. For
 * `pane.focusDown`, which sits behind `terminal.toggle` on `mod+j`
 * deliberately, the answer would be "no shortcut" for a chord that works.
 * Those commands are dispatched by `lib/usePaneNavigation.ts`, not resolved.
 */
export function findEffectiveShortcutForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
  options?: ShortcutMatchOptions,
): KeybindingShortcut | null {
  const platform = resolvePlatform(options);
  const context = resolveContext(options);
  const claimedShortcuts = new Set<string>();

  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (!binding) continue;
    if (!matchesWhenClause(binding.whenAst, context)) continue;

    const conflictKey = shortcutConflictKey(binding.shortcut, platform);
    if (claimedShortcuts.has(conflictKey)) {
      continue;
    }

    claimedShortcuts.add(conflictKey);
    if (binding.command === command) {
      return binding.shortcut;
    }
  }

  return null;
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
 * The last binding in `bindings` that this event satisfies, or null.
 *
 * Last wins, which is what lets a later rule override an earlier one. Taking
 * the candidate list as an argument is what lets a caller resolve over a
 * subset: the pane handler resolves over just the pane bindings, and doing it
 * through here rather than in a copy of this loop keeps the two from drifting.
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
    // Shortcut first, `when` second. Both must hold, so the order cannot
    // change the answer, but a `when` clause can now read the focus tree
    // while a shortcut comparison is pure arithmetic on the event.
    if (!matchesShortcut(event, binding.shortcut, platform)) continue;
    if (!matchesWhenClause(binding.whenAst, context)) continue;
    // The file-manager stand-down belongs here rather than in
    // `resolveShortcutCommand`, because that is no longer the single point
    // every resolution crosses: `usePaneNavigation` calls this function
    // directly, and a guard one level up would leave the pane chords firing
    // over an open file manager, in the capture phase, ahead of its own
    // dispatcher. A matched binding that stands down yields null rather than
    // continuing the search, so a lower-priority binding cannot inherit the
    // key the file manager just claimed.
    return standDownForFileManager(binding.command) === null ? null : binding;
  }
  return null;
}

export function resolveShortcutCommand(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): KeybindingCommand | null {
  return findLastMatchingBinding(event, keybindings, options)?.command ?? null;
}

/**
 * Fork addition. While the file manager is up over the window every host
 * chord but its own toggle stands down, so its keys — `Ctrl+O` for the
 * overview above all — reach its dispatcher unopposed. Every window listener
 * resolves through `findLastMatchingBinding`, directly or through
 * `resolveShortcutCommand` and the `is*Shortcut` helpers over it, which is why
 * the one guard is applied there rather than in each listener.
 */
function standDownForFileManager(command: KeybindingCommand): KeybindingCommand | null {
  if (command === "fileTree.miller") return command;
  return isFileManagerOpen() ? null : command;
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
  // The embedded terminal owns keystrokes while it has focus: the Ghostty
  // surface encodes the keydown and can write the pressed key into the shell
  // before our window-level shortcut handling ever runs, regardless of any
  // configured `when` clause on the jump command. Advertising jump hints
  // here would promise a shortcut that instead types into the terminal, so
  // never show them while the terminal is focused.
  if (resolveContext(options).terminalFocus) {
    return false;
  }

  const platform = resolvePlatform(options);

  for (const command of THREAD_JUMP_KEYBINDING_COMMANDS) {
    const shortcut = findEffectiveShortcutForCommand(keybindings, command, options);
    if (!shortcut) continue;
    if (matchesShortcutModifiers(modifiers, shortcut, platform)) {
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
  return matchesCommandShortcut(event, keybindings, "editor.openFavorite", options);
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
