import {
  type KeybindingRule,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  MAX_KEYBINDINGS_COUNT,
  MAX_WHEN_EXPRESSION_DEPTH,
  MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
  type ResolvedKeybindingRule,
  type ResolvedKeybindingsConfig,
  THREAD_JUMP_KEYBINDING_COMMANDS,
} from "@t3tools/contracts";

export interface ShortcutEventLike {
  getModifierState?: (key: "AltGraph") => boolean;
  type?: string;
  code?: string;
  key: string;
  repeat?: boolean;
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

export const EVENT_CODE_SHORTCUT_KEYS: Readonly<Record<string, string>> = {
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

export const US_SHIFTED_TO_UNSHIFTED_KEYS: ReadonlyMap<string, string> = new Map([
  ["!", "1"],
  ["@", "2"],
  ["#", "3"],
  ["$", "4"],
  ["%", "5"],
  ["^", "6"],
  ["&", "7"],
  ["*", "8"],
  ["(", "9"],
  [")", "0"],
  ["~", "`"],
  ["_", "-"],
  ["+", "="],
  ["{", "["],
  ["}", "]"],
  ["|", "\\"],
  [":", ";"],
  ['"', "'"],
  ["<", ","],
  [">", "."],
  ["?", "/"],
]);

export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function normalizeEventKey(key: string): string {
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

export function resolveEventKeys(event: ShortcutEventLike): Set<string> {
  const layoutKey = normalizeEventKey(event.key);
  const keys = new Set([layoutKey]);
  const letterCode = event.code?.match(/^Key([A-Z])$/)?.[1];
  if (letterCode && !/^[a-z]$/.test(layoutKey)) {
    keys.add(letterCode.toLowerCase());
  }
  keys.add(shortcutKeyFromEvent(event));
  return keys;
}

export function matchesKeybindingShortcutModifiers(
  event: ShortcutModifierStateLike,
  shortcut: KeybindingShortcut,
  platform: string,
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

export function matchesKeybindingShortcut(
  event: ShortcutEventLike,
  shortcut: KeybindingShortcut,
  platform: string,
): boolean {
  if (
    !isMacPlatform(platform) &&
    event.getModifierState?.("AltGraph") &&
    !/^[a-z0-9]$/i.test(event.key)
  )
    return false;
  if (!matchesKeybindingShortcutModifiers(event, shortcut, platform)) return false;
  return resolveEventKeys(event).has(shortcut.key);
}

type WhenToken =
  | { type: "identifier"; value: string }
  | { type: "not" }
  | { type: "and" }
  | { type: "or" }
  | { type: "lparen" }
  | { type: "rparen" };

export const DEFAULT_KEYBINDINGS: ReadonlyArray<KeybindingRule> = [
  { key: "mod+b", command: "sidebar.toggle" },
  { key: "mod+[", command: "navigation.back", when: "!terminalFocus" },
  { key: "mod+]", command: "navigation.forward", when: "!terminalFocus" },
  // Two rules share mod+j; the context and the order are both load-bearing. Without `chatFocus` backfill
  // skips this row for an existing config. The pane rule must come FIRST: resolution is last-wins, and
  // ChatView drops a pane command, so the drawer would never open. usePaneNavigation matches the pane
  // rule directly and consumes the chord only when the drawer is already open.
  { key: "mod+j", command: "pane.focusDown", when: "chatFocus" },
  { key: "mod+j", command: "terminal.toggle" },
  { key: "mod+alt+b", command: "rightPanel.toggle" },
  { key: "mod+shift+b", command: "threadPanel.toggle", when: "!terminalFocus" },
  { key: "mod+t", command: "rightPanel.new", when: "rightPanelOpen && !terminalFocus" },
  { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
  { key: "mod+shift+d", command: "terminal.splitVertical", when: "terminalFocus" },
  { key: "mod+n", command: "terminal.new", when: "terminalFocus" },
  // Mesura: Ctrl+Q closes what Ctrl+W closes, as Super+Q closes the focused
  // window on Hyprland. Literal ctrl, not mod: Cmd+Q stays macOS's quit. The
  // desktop app gives the chord up on Linux (DesktopWindow.ts). Placed first
  // so the label each command shows stays mod+w (last wins).
  { key: "ctrl+q", command: "terminal.close", when: "terminalFocus" },
  { key: "ctrl+q", command: "rightPanel.close", when: "!terminalFocus" },
  { key: "mod+w", command: "terminal.close", when: "terminalFocus" },
  { key: "mod+w", command: "rightPanel.close", when: "!terminalFocus" },
  { key: "mod+shift+t", command: "view.reopenClosed" },
  // Moved off mod+d so the reading scroll can take the vim pair mod+u/mod+d.
  // The move reaches existing configs through RETIRED_KEYBINDING_DEFAULTS
  // below, which startup applies before it backfills missing defaults.
  { key: "mod+shift+d", command: "diff.toggle", when: "!terminalFocus" },
  { key: "mod+shift+j", command: "preview.toggle" },
  { key: "mod+r", command: "preview.refresh", when: "previewFocus" },
  { key: "mod+alt+l", command: "preview.focusUrl", when: "previewFocus" },
  { key: "mod+=", command: "preview.zoomIn", when: "previewFocus" },
  { key: "mod++", command: "preview.zoomIn", when: "previewFocus" },
  { key: "mod+-", command: "preview.zoomOut", when: "previewFocus" },
  { key: "mod+0", command: "preview.resetZoom", when: "previewFocus" },
  { key: "mod+o", command: "commandPalette.toggle", when: "!terminalFocus" },
  { key: "mod+p", command: "filePicker.toggle", when: "!terminalFocus" },
  // The content search gave mod+shift+f up to the project scope picker. The move
  // reaches existing configs through RETIRED_KEYBINDING_DEFAULTS below; without
  // that entry the freed chord stays claimed and the picker silently gets nothing.
  { key: "mod+alt+g", command: "projectSearch.toggle", when: "!terminalFocus" },
  { key: "mod+shift+f", command: "projectScope.toggle", when: "!terminalFocus" },
  // A new command on a free chord: the per-command startup backfill installs it.
  // mod+shift+p stays thread.pin.
  { key: "mod+alt+p", command: "projectScope.toggleAll", when: "!terminalFocus" },
  // A new command on a free chord beside mod+k (the same overlay, narrowed to threads), so per-command
  // backfill installs it without a RETIRED or ADDED entry.
  { key: "mod+alt+k", command: "threadSearch.toggle", when: "!terminalFocus" },
  // Mesura: upstream binds usage.open to mod+u and theme.select to mod+alt+a. mod+u is the chat's vim
  // half-page scroll and Neovim's key in the editor, so usage.open takes mod+alt+u. mod+alt+a is
  // composer.attachFiles (it passes the developer's global Hyprland ALT+A), so theme.select ships unbound.
  { key: "mod+alt+u", command: "usage.open", when: "!terminalFocus" },
  { key: "mod+alt+shift+a", command: "appearance.cycle", when: "!terminalFocus" },
  { key: "mod+alt+shift+t", command: "themeEditor.toggle" },
  { key: "mod+s", command: "composer.stash", when: "!terminalFocus" },
  { key: "mod+shift+enter", command: "thread.steerQueuedMessage", when: "!terminalFocus" },
  { key: "alt+arrowup", command: "thread.editQueuedMessage", when: "composerFocus" },
  { key: "mod+enter", command: "composer.sendAlternate", when: "composerFocus && turnRunning" },
  {
    key: "mod+enter",
    command: "composer.sendBackground",
    when: "composerFocus && draftThreadRoute",
  },
  {
    key: "mod+alt+enter",
    command: "composer.sendBackground",
    when: "composerFocus && draftThreadRoute",
  },
  {
    key: "mod+alt+enter",
    command: "composer.sendAndNewThread",
    when: "composerFocus && !draftThreadRoute",
  },
  // Two chords; the label shows the last. The developer's Hyprland binds ALT+A globally, so mod+alt+a
  // (the mod+alt family) reaches the app there, and alt+a stays for other machines. Existing configs get
  // mod+alt+a from ADDED_KEYBINDING_DEFAULTS.
  { key: "alt+a", command: "composer.attachFiles", when: "!terminalFocus" },
  { key: "mod+alt+a", command: "composer.attachFiles", when: "!terminalFocus" },
  // Fork addition: a new command on a free chord, installed by the per-command
  // startup backfill; no RETIRED or ADDED entry, as with alt+q below.
  { key: "mod+e", command: "fileTree.toggle", when: "!terminalFocus" },
  // Two chords, and the label shows the last. mod+shift+e is the file
  // manager's own, back since the effort picker gave it up (see
  // WITHDRAWN_KEYBINDING_DEFAULTS); Firefox and Zen keep it for their Network
  // Monitor, so mod+alt+e stays as the chord a browser lets through.
  { key: "mod+alt+e", command: "fileTree.miller", when: "!terminalFocus" },
  { key: "mod+shift+e", command: "fileTree.miller", when: "!terminalFocus" },
  // Fork: Tree diff and its mode menu. composer.branch holds Symmetria IDE's mod+shift+g; alt+g and alt+c
  // are free in the app and in the developer's Hyprland (its G and C binds use Super). Browsers keep alt+d
  // for the address bar. New commands, so per-command backfill installs them.
  { key: "alt+g", command: "treeDiff.toggle", when: "!terminalFocus" },
  { key: "alt+c", command: "diff.modeMenu", when: "!terminalFocus" },
  { key: "alt+u", command: "usage.peek" },
  // Fork addition: the Hosts dock's held peek, on a free chord, so the
  // per-command startup backfill installs it; no RETIRED or ADDED entry. No
  // `when` clause, like alt+u: both docks open over a focused terminal too.
  { key: "alt+s", command: "hosts.peek" },
  // Mesura dictation, active only while a recording or the last stopped job is live. Listed after
  // hosts.peek because resolution is last-wins: alt+s selects save during a dictation and stays the Hosts
  // peek otherwise. dictation.toggle ships unbound; the user guide gives the Hyprland bind.
  { key: "alt+s", command: "dictation.mode.clipboard", when: "dictationActive" },
  { key: "alt+i", command: "dictation.mode.inject", when: "dictationActive" },
  { key: "alt+enter", command: "dictation.mode.submit", when: "dictationActive" },
  { key: "alt+space", command: "dictation.pause", when: "dictationActive" },
  { key: "alt+r", command: "dictation.restart", when: "dictationActive" },
  { key: "alt+x", command: "dictation.cancel", when: "dictationActive" },
  // Fork addition: the sidebar's Working section. alt+z is free in the app and in the developer's
  // Hyprland (checked 2026-10-26), so per-command backfill installs it.
  { key: "alt+z", command: "sidebar.toggleWorking", when: "!terminalFocus" },
  { key: "mod+n", command: "chat.new", when: "!terminalFocus" },
  { key: "mod+shift+o", command: "chat.new", when: "!terminalFocus" },
  { key: "mod+shift+n", command: "chat.newLocal", when: "!terminalFocus" },
  { key: "mod+alt+n", command: "chat.newWithoutProject", when: "!terminalFocus" },
  { key: "mod+f", command: "chat.find", when: "!terminalFocus && !previewFocus" },
  // Order matters for the label, not for matching: shortcutLabelForCommand
  // reports the last binding that wins, so the everywhere-works chord goes
  // last and alt+m stays the alternate.
  { key: "alt+m", command: "modelPicker.toggle", when: "!terminalFocus" },
  { key: "mod+shift+m", command: "modelPicker.toggle", when: "!terminalFocus" },
  // The host chord now cycles machines; composer.host stays, unbound, and its
  // strip chip opens the run context drawer on its Host tab.
  { key: "mod+shift+h", command: "runContext.cycleMachine", when: "!terminalFocus" },
  // Fork: upstream's `mod+shift+e` for composer.effort is withdrawn; the chord
  // is fileTree.miller's, and alt+e (traitsPicker.toggle) opens the same
  // picker. The command stays, unbound, for anyone who wants it back.
  { key: "mod+shift+a", command: "composer.mode", when: "!terminalFocus" },
  { key: "mod+shift+x", command: "composer.workspace", when: "!terminalFocus" },
  { key: "mod+shift+g", command: "composer.branch", when: "!terminalFocus" },
  { key: "mod+shift+l", command: "composer.previousWorktree", when: "!terminalFocus" },
  { key: "mod+shift+k", command: "pullRequest.copyNumber", when: "!terminalFocus" },
  { key: "mod+shift+arrowup", command: "modelPicker.previousProvider", when: "modelPickerOpen" },
  { key: "mod+shift+arrowdown", command: "modelPicker.nextProvider", when: "modelPickerOpen" },
  { key: "alt+e", command: "traitsPicker.toggle", when: "!terminalFocus" },
  // alt+w opens the whole run context drawer. workspacePicker.toggle stays,
  // unbound, and opens the drawer on its Workspace tab when bound.
  { key: "alt+w", command: "runContext.toggle", when: "!terminalFocus" },
  // Two chords, and the label shows the last. Browsers keep mod+shift+w to
  // close the window and never deliver it to the page, so alt+shift+w is the
  // chord a browser lets through; mod+shift+w reaches the desktop app.
  { key: "alt+shift+w", command: "runContext.toggleWorkspace", when: "!terminalFocus" },
  { key: "mod+shift+w", command: "runContext.toggleWorkspace", when: "!terminalFocus" },
  { key: "alt+b", command: "branchPicker.toggle", when: "!terminalFocus" },
  // A new command, so no existing config mentions it and the ordinary
  // per-command startup backfill installs it. No ADDED_KEYBINDING_DEFAULTS
  // entry: that mechanism exists for a SECOND default on a command a config
  // already binds.
  { key: "alt+q", command: "question.toggleCollapse", when: "!terminalFocus" },
  // A new command on a free chord, so the per-command startup backfill
  // installs it, as with alt+q above.
  { key: "mod+alt+r", command: "thread.rename", when: "!terminalFocus" },
  // Directional pane focus, deliberately unconditional: the chord has one
  // meaning in every pane, which is what stops two surfaces claiming a key.
  // New commands, so the per-command startup backfill installs them and no
  // ADDED_KEYBINDING_DEFAULTS entry is needed.
  { key: "mod+h", command: "pane.focusLeft" },
  { key: "mod+k", command: "pane.focusUp" },
  { key: "mod+l", command: "pane.focusRight" },
  // Scoped to the chat pane rather than to "not the terminal". The editor
  // is neither, and these two keys are half the motion set inside it.
  { key: "mod+u", command: "chat.scrollHalfPageUp", when: "chatFocus" },
  { key: "mod+d", command: "chat.scrollHalfPageDown", when: "chatFocus" },
  // Moved off mod+o for the command palette, and onto alt+o rather than
  // mod+shift+o: that key already carries a second `chat.new` default, and
  // an unconditional rule on it would shadow `chat.new` outright under
  // last-wins. alt+o also joins the alt+letter family the other pickers use.
  { key: "alt+o", command: "editor.openFavorite" },
  // The only bare letters in the table: `sidebarFocus` covers a handful of buttons, and the second clause
  // returns the key while typing in a box. Listed before the rows below so the label resolver (last
  // winning binding) advertises the bracket pair, not a bare `j`.
  { key: "j", command: "thread.next", when: "sidebarFocus && !sidebarSearchFocus" },
  { key: "k", command: "thread.previous", when: "sidebarFocus && !sidebarSearchFocus" },
  // The page step: the chat reads these keys as a half-page scroll and the terminal as a split, told
  // apart by which pane has the keyboard. No search guard: a modifier chord types nothing into a box.
  // New commands, so per-command backfill installs them.
  { key: "mod+d", command: "thread.nextPage", when: "sidebarFocus" },
  { key: "mod+u", command: "thread.previousPage", when: "sidebarFocus" },
  // Browsers never deliver ctrl+tab to a page, so this pair reaches the desktop app only. Listed first so
  // the label resolver (last winning binding) reports the bracket pair that every surface receives. Gated
  // on terminal focus because Ghostty encodes ctrl+tab and the key would also reach the shell.
  { key: "ctrl+shift+tab", command: "thread.previous", when: "!terminalFocus" },
  { key: "ctrl+tab", command: "thread.next", when: "!terminalFocus" },
  { key: "mod+shift+[", command: "thread.previous" },
  { key: "mod+shift+]", command: "thread.next" },
  // Mesura: inside the right panel the same chords walk its tabs. After the
  // thread rules on purpose: resolution is last-wins, so with the panel
  // focused these answer. New commands, so the per-command backfill installs
  // them. A terminal tab keeps ctrl+tab, as the thread rules leave it.
  {
    key: "ctrl+shift+tab",
    command: "rightPanel.previousTab",
    when: "panelFocus && !terminalFocus",
  },
  { key: "ctrl+tab", command: "rightPanel.nextTab", when: "panelFocus && !terminalFocus" },
  // Mesura: a new tab is the panel launcher, as Ctrl+T is in a browser.
  // Desktop only in practice: a browser keeps Ctrl+T for its own tabs.
  { key: "mod+t", command: "rightPanel.newTab", when: "panelFocus && !terminalFocus" },
  { key: "mod+shift+c", command: "thread.copyReference", when: "!terminalFocus" },
  { key: "mod+shift+s", command: "thread.settle", when: "!terminalFocus" },
  { key: "mod+shift+p", command: "thread.pin", when: "!terminalFocus" },
  { key: "mod+z", command: "thread.undo", when: "!terminalFocus && !editableFocus" },
  ...THREAD_JUMP_KEYBINDING_COMMANDS.map((command, index) => ({
    // Mesura: the tenth jump is mod+0, the digit after 9 on the keyboard.
    key: `mod+${(index + 1) % 10}`,
    command,
    // Mesura: mod+0 is also the preview's reset zoom, which keeps it while the
    // preview has focus, the way the model picker keeps mod+1..9 while open.
    when:
      command === "thread.jump.10"
        ? "!modelPickerOpen && !previewFocus && isDesktop"
        : "!modelPickerOpen && isDesktop",
  })),
  ...MODEL_PICKER_JUMP_KEYBINDING_COMMANDS.map((command, index) => ({
    key: `mod+${index + 1}`,
    command,
    when: "modelPickerOpen && isDesktop",
  })),
  { key: "c", command: "usage.cost", when: "usagePageOpen" },
  { key: "t", command: "usage.tokens", when: "usagePageOpen" },
  { key: "l", command: "usage.limits", when: "usagePageOpen" },
  { key: "mod+shift+1", command: "usage.period.day", when: "usagePageOpen" },
  { key: "mod+shift+2", command: "usage.period.week", when: "usagePageOpen" },
  { key: "mod+shift+3", command: "usage.period.month", when: "usagePageOpen" },
  { key: "mod+shift+4", command: "usage.period.quarter", when: "usagePageOpen" },
];

/**
 * Per-command backfill never moves a default a config already mentions, so the freed key silently gets
 * nothing. Each entry lets startup rewrite that one rule. `from` must match key, command and `when`
 * exactly, or the rule is the user's own. `toWhen` moves the context, which has the same problem.
 */
export const RETIRED_KEYBINDING_DEFAULTS: ReadonlyArray<{
  readonly from: KeybindingRule;
  readonly toKey: string;
  readonly toWhen?: string;
}> = [
  {
    // Freed for chat.scrollHalfPageDown; see the diff.toggle default above.
    from: { key: "mod+d", command: "diff.toggle", when: "!terminalFocus" },
    toKey: "mod+shift+d",
  },
  {
    // Freed for projectScope.toggle; see the projectSearch.toggle default above.
    // The rewrite runs before the per-command backfill, which is what lets the
    // picker take mod+shift+f on a config that already held the search there.
    from: { key: "mod+shift+f", command: "projectSearch.toggle", when: "!terminalFocus" },
    toKey: "mod+alt+g",
  },
  {
    // v0.0.42 gives mod+shift+g to composer.branch, so the destination above
    // moved again. This entry catches the configs that already took it.
    from: { key: "mod+shift+g", command: "projectSearch.toggle", when: "!terminalFocus" },
    toKey: "mod+alt+g",
  },
  {
    // Narrowed to the chat pane, on the key it already had. Left as it was,
    // the pair keeps firing in the editor, where Neovim owns both keys.
    from: { key: "mod+u", command: "chat.scrollHalfPageUp", when: "!terminalFocus" },
    toKey: "mod+u",
    toWhen: "chatFocus",
  },
  {
    from: { key: "mod+d", command: "chat.scrollHalfPageDown", when: "!terminalFocus" },
    toKey: "mod+d",
    toWhen: "chatFocus",
  },
  {
    // Freed for pane.focusRight. The address bar is reachable from the same
    // chord with shift, and only while the preview has focus anyway.
    from: { key: "mod+l", command: "preview.focusUrl", when: "previewFocus" },
    toKey: "mod+alt+l",
  },
  {
    // v0.0.42 gives mod+shift+l to composer.previousWorktree. Same shape as the
    // projectSearch.toggle pair above.
    from: { key: "mod+shift+l", command: "preview.focusUrl", when: "previewFocus" },
    toKey: "mod+alt+l",
  },
  {
    // A fork-only command whose mod+shift+ chord v0.0.42 claimed for pullRequest.copyNumber. It keeps its
    // letter on mod+alt, so an installed config follows without relearning the mnemonic.
    from: { key: "mod+shift+k", command: "threadSearch.toggle", when: "!terminalFocus" },
    toKey: "mod+alt+k",
  },
  {
    // Moves aside for the palette on mod+o below. The two are independent: a destination is claimed only
    // by a rule with the same key AND the same `when`, and these differ.
    from: { key: "mod+o", command: "editor.openFavorite" },
    toKey: "alt+o",
  },
  {
    // Freed for pane.focusUp.
    from: { key: "mod+k", command: "commandPalette.toggle", when: "!terminalFocus" },
    toKey: "mod+o",
  },
];

/**
 * A second default for a command a config already mentions never reaches it through per-command
 * backfill. A new default never existed for the user to remove, so adding it once is safe; the server
 * records each stable id after applying it, so a deleted shortcut stays deleted. Never edit or reuse
 * an id: an installation that recorded it skips the new rule forever.
 */
export interface AddedKeybindingDefault {
  readonly id: string;
  readonly rule: KeybindingRule;
  /**
   * The shipped default this addition sits before, when the command has several. Order decides the
   * label, not matching: `shortcutLabelForCommand` reports the last winning binding, so appending would
   * make an upgraded install advertise a different chord than a fresh one.
   */
  readonly insertBefore?: KeybindingRule;
}

export const ADDED_KEYBINDING_DEFAULTS: ReadonlyArray<AddedKeybindingDefault> = [
  {
    id: "2026-08-model-picker-alt-m",
    rule: { key: "alt+m", command: "modelPicker.toggle", when: "!terminalFocus" },
    insertBefore: { key: "mod+shift+m", command: "modelPicker.toggle", when: "!terminalFocus" },
  },
  {
    id: "2026-08-thread-next-ctrl-tab",
    rule: { key: "ctrl+tab", command: "thread.next", when: "!terminalFocus" },
    insertBefore: { key: "mod+shift+]", command: "thread.next" },
  },
  {
    id: "2026-08-thread-previous-ctrl-shift-tab",
    rule: { key: "ctrl+shift+tab", command: "thread.previous", when: "!terminalFocus" },
    insertBefore: { key: "mod+shift+[", command: "thread.previous" },
  },
  // Second defaults on commands an existing config already binds, so the
  // per-command backfill would skip them and only this mechanism delivers
  // them. The page pair needs no entry beside these: those commands are new,
  // and a command a config has never heard of the backfill installs itself.
  {
    id: "2026-09-sidebar-thread-next-j",
    rule: { key: "j", command: "thread.next", when: "sidebarFocus && !sidebarSearchFocus" },
    insertBefore: { key: "ctrl+tab", command: "thread.next", when: "!terminalFocus" },
  },
  {
    id: "2026-09-sidebar-thread-previous-k",
    rule: { key: "k", command: "thread.previous", when: "sidebarFocus && !sidebarSearchFocus" },
    insertBefore: { key: "ctrl+shift+tab", command: "thread.previous", when: "!terminalFocus" },
  },
  // Appended, so it is the last fileTree.miller rule and the label, as on a
  // fresh install. Lands only once WITHDRAWN has freed mod+shift+e.
  {
    id: "2026-09-file-manager-mod-shift-e",
    rule: { key: "mod+shift+e", command: "fileTree.miller", when: "!terminalFocus" },
  },
  // Appended, so it is the last composer.attachFiles rule and the label, as
  // on a fresh install.
  {
    id: "2026-09-attach-files-mod-alt-a",
    rule: { key: "mod+alt+a", command: "composer.attachFiles", when: "!terminalFocus" },
  },
  // Before mod+w, so mod+w stays the label of both commands.
  {
    id: "2026-10-terminal-close-ctrl-q",
    rule: { key: "ctrl+q", command: "terminal.close", when: "terminalFocus" },
    insertBefore: { key: "mod+w", command: "terminal.close", when: "terminalFocus" },
  },
  {
    id: "2026-10-right-panel-close-ctrl-q",
    rule: { key: "ctrl+q", command: "rightPanel.close", when: "!terminalFocus" },
    insertBefore: { key: "mod+w", command: "rightPanel.close", when: "!terminalFocus" },
  },
];

/**
 * Withdrawn defaults with no replacement key. Startup removes each from a config once, before retired
 * rewrites and additions, so an addition can land on the freed chord in the same startup. The ledger
 * records the id even when the rule was absent, so a user who rebinds it keeps it. A rule must match
 * key, command and `when` exactly. Never edit or reuse an id.
 */
export interface WithdrawnKeybindingDefault {
  readonly id: string;
  readonly rule: KeybindingRule;
}

export const WITHDRAWN_KEYBINDING_DEFAULTS: ReadonlyArray<WithdrawnKeybindingDefault> = [
  {
    id: "2026-09-withdraw-composer-effort-mod-shift-e",
    rule: { key: "mod+shift+e", command: "composer.effort", when: "!terminalFocus" },
  },
  // The run context drawer takes both chords for new commands. Withdrawing
  // the old rules first frees them, so the per-command backfill installs
  // runContext.cycleMachine and runContext.toggle in the same startup.
  {
    id: "2026-10-withdraw-composer-host-mod-shift-h",
    rule: { key: "mod+shift+h", command: "composer.host", when: "!terminalFocus" },
  },
  {
    id: "2026-10-withdraw-workspace-picker-alt-w",
    rule: { key: "alt+w", command: "workspacePicker.toggle", when: "!terminalFocus" },
  },
];

export interface WithdrawnKeybindingResult {
  readonly id: string;
  readonly rule: KeybindingRule;
  /** `dropped` removed the rule; `absent` found nothing to remove. Both are recorded. */
  readonly outcome: "dropped" | "absent";
}

/** Removes every withdrawn default the ledger has not recorded yet. */
export function dropWithdrawnKeybindingDefaults(input: {
  readonly config: ReadonlyArray<KeybindingRule>;
  readonly appliedIds: ReadonlySet<string>;
}): {
  readonly config: ReadonlyArray<KeybindingRule>;
  readonly results: ReadonlyArray<WithdrawnKeybindingResult>;
} {
  let config = input.config;
  const results: WithdrawnKeybindingResult[] = [];
  for (const withdrawn of WITHDRAWN_KEYBINDING_DEFAULTS) {
    if (input.appliedIds.has(withdrawn.id)) continue;
    const kept = config.filter((rule) => !isSameKeybindingRule(rule, withdrawn.rule));
    const outcome = kept.length === config.length ? "absent" : "dropped";
    results.push({ id: withdrawn.id, rule: withdrawn.rule, outcome });
    config = kept;
  }
  return { config, results };
}

export type IntroducedKeybindingAdditionOutcome =
  /** Appended to the config. */
  | "applied"
  /** The exact rule was already there, so nothing changed. */
  | "already-present"
  /** Another rule holds that chord; forcing it would disable one of the two. */
  | "context-claimed";

export interface IntroducedKeybindingAdditionResult {
  readonly id: string;
  readonly rule: KeybindingRule;
  readonly outcome: IntroducedKeybindingAdditionOutcome;
}

export interface IntroducedKeybindingDefaultsInput {
  readonly config: ReadonlyArray<KeybindingRule>;
  readonly appliedIds: ReadonlySet<string>;
  /** Largest config the caller may persist; additions stop at it. */
  readonly capacity: number;
  /**
   * Whether an existing rule holds a chord. Injected because the authoritative
   * comparison normalizes the chord first — `Alt+M`, `alt + m`, and `m+alt` are
   * one context — and that normalizer lives with the server's config codecs.
   */
  readonly claimsShortcutContext: (rule: KeybindingRule, candidate: KeybindingRule) => boolean;
}

/**
 * An addition whose chord another rule holds is skipped but recorded: forcing it would silently
 * disable one command under last-wins resolution, and recording stops a retry on every boot.
 * Additions dropped for lack of room return in `deferred` and are NOT recorded, so they come back.
 */
export function addIntroducedKeybindingDefaults(input: IntroducedKeybindingDefaultsInput): {
  readonly config: ReadonlyArray<KeybindingRule>;
  readonly results: ReadonlyArray<IntroducedKeybindingAdditionResult>;
  readonly deferred: ReadonlyArray<AddedKeybindingDefault>;
} {
  const next = [...input.config];
  const results: IntroducedKeybindingAdditionResult[] = [];
  const deferred: AddedKeybindingDefault[] = [];

  for (const addition of ADDED_KEYBINDING_DEFAULTS) {
    if (input.appliedIds.has(addition.id)) continue;

    if (next.some((entry) => isSameKeybindingRule(entry, addition.rule))) {
      results.push({ id: addition.id, rule: addition.rule, outcome: "already-present" });
      continue;
    }
    if (next.some((entry) => input.claimsShortcutContext(entry, addition.rule))) {
      results.push({ id: addition.id, rule: addition.rule, outcome: "context-claimed" });
      continue;
    }
    if (next.length >= input.capacity) {
      deferred.push(addition);
      continue;
    }

    const before = addition.insertBefore;
    const index = before ? next.findIndex((entry) => isSameKeybindingRule(entry, before)) : -1;
    if (index === -1) {
      next.push(addition.rule);
    } else {
      next.splice(index, 0, addition.rule);
    }
    results.push({ id: addition.id, rule: addition.rule, outcome: "applied" });
  }

  const applied = results.some((entry) => entry.outcome === "applied");
  return { config: applied ? next : input.config, results, deferred };
}

export interface RetiredKeybindingRewrite {
  readonly command: KeybindingRule["command"];
  readonly fromKey: string;
  readonly toKey: string;
  /** Present only where the rewrite moved the rule's context as well. */
  readonly toWhen?: string;
}

export interface BlockedRetiredKeybindingRewrite extends RetiredKeybindingRewrite {
  readonly reason: "destination-claimed";
}

/** True when two rules bind the same command on the same shortcut context. */
export function isSameKeybindingRule(left: KeybindingRule, right: KeybindingRule): boolean {
  return (
    left.command === right.command &&
    left.key === right.key &&
    (left.when ?? undefined) === (right.when ?? undefined)
  );
}

function claimsShortcutContext(
  rule: KeybindingRule,
  key: string,
  when: string | undefined,
): boolean {
  return rule.key === key && (rule.when ?? undefined) === when;
}

/**
 * Returns the config unchanged when nothing moved, so callers can skip the write. `from` must match
 * exactly, so a user-edited rule stays. A rewrite onto a context another rule holds is skipped and
 * returned in `blocked`: under last-wins resolution it would silently disable one command. The pass is
 * idempotent, and rewrites that collapse onto an identical rule are deduped.
 */
export function migrateRetiredKeybindingDefaults(config: ReadonlyArray<KeybindingRule>): {
  readonly config: ReadonlyArray<KeybindingRule>;
  readonly rewrites: ReadonlyArray<RetiredKeybindingRewrite>;
  readonly blocked: ReadonlyArray<BlockedRetiredKeybindingRewrite>;
} {
  const rewrites: RetiredKeybindingRewrite[] = [];
  const blocked: BlockedRetiredKeybindingRewrite[] = [];
  const next: KeybindingRule[] = [];

  for (const rule of config) {
    const retired = RETIRED_KEYBINDING_DEFAULTS.find((entry) =>
      isSameKeybindingRule(entry.from, rule),
    );
    if (!retired) {
      next.push(rule);
      continue;
    }

    const destinationWhen = retired.toWhen ?? rule.when ?? undefined;
    const destination: KeybindingRule = {
      ...rule,
      key: retired.toKey,
      ...(destinationWhen === undefined ? {} : { when: destinationWhen }),
    };
    // Checked against the destination's context, not the source's: a rewrite
    // that only narrows `when` stays on its key, so the source context would
    // ask whether the rule collides with itself.
    const claimedByAnother = config.some(
      (entry) => entry !== rule && claimsShortcutContext(entry, retired.toKey, destinationWhen),
    );
    if (claimedByAnother) {
      blocked.push({
        command: rule.command,
        fromKey: rule.key,
        toKey: retired.toKey,
        reason: "destination-claimed",
      });
      next.push(rule);
      continue;
    }

    // A config may hold the retired rule more than once; collapsing both onto
    // the destination would persist a duplicate.
    if (next.some((entry) => isSameKeybindingRule(entry, destination))) {
      continue;
    }

    rewrites.push({
      command: rule.command,
      fromKey: rule.key,
      toKey: retired.toKey,
      ...(retired.toWhen === undefined ? {} : { toWhen: retired.toWhen }),
    });
    next.push(destination);
  }

  return rewrites.length === 0
    ? { config, rewrites, blocked }
    : { config: next, rewrites, blocked };
}

function normalizeKeyToken(token: string): string {
  if (token === "space") return " ";
  if (token === "esc") return "escape";
  return token;
}

export function parseKeybindingShortcut(value: string): KeybindingShortcut | null {
  const rawTokens = value
    .toLowerCase()
    .split("+")
    .map((token) => token.trim());
  const tokens = [...rawTokens];
  let trailingEmptyCount = 0;
  while (tokens[tokens.length - 1] === "") {
    trailingEmptyCount += 1;
    tokens.pop();
  }
  if (trailingEmptyCount > 0) {
    tokens.push("+");
  }
  if (tokens.some((token) => token.length === 0)) {
    return null;
  }
  if (tokens.length === 0) return null;

  let key: string | null = null;
  let metaKey = false;
  let ctrlKey = false;
  let shiftKey = false;
  let altKey = false;
  let modKey = false;

  for (const token of tokens) {
    switch (token) {
      case "cmd":
      case "meta":
        metaKey = true;
        break;
      case "ctrl":
      case "control":
        ctrlKey = true;
        break;
      case "shift":
        shiftKey = true;
        break;
      case "alt":
      case "option":
        altKey = true;
        break;
      case "mod":
        modKey = true;
        break;
      default: {
        if (key !== null) return null;
        key = normalizeKeyToken(token);
      }
    }
  }

  if (key === null) return null;
  return {
    key,
    metaKey,
    ctrlKey,
    shiftKey,
    altKey,
    modKey,
  };
}

function tokenizeWhenExpression(expression: string): WhenToken[] | null {
  const tokens: WhenToken[] = [];
  let index = 0;

  while (index < expression.length) {
    const current = expression[index];
    if (!current) break;

    if (/\s/.test(current)) {
      index += 1;
      continue;
    }
    if (expression.startsWith("&&", index)) {
      tokens.push({ type: "and" });
      index += 2;
      continue;
    }
    if (expression.startsWith("||", index)) {
      tokens.push({ type: "or" });
      index += 2;
      continue;
    }
    if (current === "!") {
      tokens.push({ type: "not" });
      index += 1;
      continue;
    }
    if (current === "(") {
      tokens.push({ type: "lparen" });
      index += 1;
      continue;
    }
    if (current === ")") {
      tokens.push({ type: "rparen" });
      index += 1;
      continue;
    }

    const identifier = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(expression.slice(index));
    if (!identifier) {
      return null;
    }
    tokens.push({ type: "identifier", value: identifier[0] });
    index += identifier[0].length;
  }

  return tokens;
}

export function parseKeybindingWhenExpression(expression: string): KeybindingWhenNode | null {
  const tokens = tokenizeWhenExpression(expression);
  if (!tokens || tokens.length === 0) return null;
  let index = 0;

  const parsePrimary = (depth: number): KeybindingWhenNode | null => {
    if (depth > MAX_WHEN_EXPRESSION_DEPTH) {
      return null;
    }
    const token = tokens[index];
    if (!token) return null;

    if (token.type === "identifier") {
      index += 1;
      return { type: "identifier", name: token.value };
    }

    if (token.type === "lparen") {
      index += 1;
      const expressionNode = parseOr(depth + 1);
      const closeToken = tokens[index];
      if (!expressionNode || !closeToken || closeToken.type !== "rparen") {
        return null;
      }
      index += 1;
      return expressionNode;
    }

    return null;
  };

  const parseUnary = (depth: number): KeybindingWhenNode | null => {
    let notCount = 0;
    while (tokens[index]?.type === "not") {
      index += 1;
      notCount += 1;
      if (notCount > MAX_WHEN_EXPRESSION_DEPTH) {
        return null;
      }
    }

    let node = parsePrimary(depth);
    if (!node) return null;

    while (notCount > 0) {
      node = { type: "not", node };
      notCount -= 1;
    }

    return node;
  };

  const parseAnd = (depth: number): KeybindingWhenNode | null => {
    let left = parseUnary(depth);
    if (!left) return null;

    while (tokens[index]?.type === "and") {
      index += 1;
      const right = parseUnary(depth);
      if (!right) return null;
      left = { type: "and", left, right };
    }

    return left;
  };

  const parseOr = (depth: number): KeybindingWhenNode | null => {
    let left = parseAnd(depth);
    if (!left) return null;

    while (tokens[index]?.type === "or") {
      index += 1;
      const right = parseAnd(depth);
      if (!right) return null;
      left = { type: "or", left, right };
    }

    return left;
  };

  const ast = parseOr(0);
  if (!ast || index !== tokens.length) return null;
  return ast;
}

export function compileResolvedKeybindingRule(rule: KeybindingRule): ResolvedKeybindingRule | null {
  const shortcut = parseKeybindingShortcut(rule.key);
  if (!shortcut) return null;

  if (rule.when !== undefined) {
    const whenAst = parseKeybindingWhenExpression(rule.when);
    if (!whenAst) return null;
    return {
      command: rule.command,
      shortcut,
      whenAst,
    };
  }

  return {
    command: rule.command,
    shortcut,
  };
}

export function compileResolvedKeybindingsConfig(
  config: ReadonlyArray<KeybindingRule>,
): ResolvedKeybindingsConfig {
  const compiled: ResolvedKeybindingRule[] = [];
  for (const rule of config) {
    const result = compileResolvedKeybindingRule(rule);
    if (result) {
      compiled.push(result);
    }
  }
  return compiled.slice(-MAX_KEYBINDINGS_COUNT);
}

export const DEFAULT_RESOLVED_KEYBINDINGS = compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS);

export function mergeWithDefaultKeybindings(
  custom: ResolvedKeybindingsConfig,
): ResolvedKeybindingsConfig {
  if (custom.length === 0) {
    return [...DEFAULT_RESOLVED_KEYBINDINGS];
  }

  const overriddenCommands = new Set(custom.map((binding) => binding.command));
  const retainedDefaults = DEFAULT_RESOLVED_KEYBINDINGS.filter(
    (binding) => !overriddenCommands.has(binding.command),
  );
  const merged = [...retainedDefaults, ...custom];

  if (merged.length <= MAX_KEYBINDINGS_COUNT) {
    return merged;
  }

  return merged.slice(-MAX_KEYBINDINGS_COUNT);
}
