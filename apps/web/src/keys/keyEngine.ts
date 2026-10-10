import type { KeybindingCommand } from "@t3tools/contracts";
import { keyTokenOf } from "@mesura/keys/keyToken";
import { compileKeymap, whichKeyRows, type KeyMode, type KeyNode } from "@mesura/keys/keymap";
import { IDLE_SEQUENCE, stepSequence, type SequenceState } from "@mesura/keys/sequence";

import { runRegisteredCommand } from "~/commands/commandRegistry";

import { DEFAULT_KEYMAP, isEngineCommand } from "./defaultKeymap";
import {
  composerEditorElement,
  deepActiveElement,
  resolveKeyScope,
  type KeyScope,
} from "./focusScope";
import {
  readKeyEngineSnapshot,
  updateKeyEngineSnapshot,
  type EngineModeLabel,
} from "./keyEngineStore";
import { toggleComposerExpanded } from "./composer/composerExpanded";
import {
  cancelComposerNormalResume,
  composerNormalOffset,
  resumeComposerNormalOnFocus,
} from "./composer/composerSurface";
import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { focusPane, getFocusedPane, notePointerPane } from "~/lib/paneFocus";
import { handlePaneKey, isPaneModeActive, startPaneMode, stopPaneMode } from "./paneMode";

/**
 * The modal key engine's host: one `keydown` listener on `window`, in the
 * capture phase, installed before React renders anything.
 *
 * Installing it first is what lets it outrank every other window listener:
 * listeners on the same target and phase run in registration order, and
 * ChatView's type-to-focus, the pane chords and the sidebar all register in
 * effects that run later. A consumed key is stopped with
 * `stopImmediatePropagation`, so none of them ever sees it.
 *
 * Routing for a key, in order:
 * 1. Off, or a composition in progress: not ours.
 * 2. A passthrough scope (terminal, Neovim editor, open dialog or menu,
 *    command palette): not ours. In a tree, only the leader and the sequence
 *    it starts are ours.
 * 3. The composer: its surface decides (insert passes keys, Escape leaves).
 * 4. Any other text input: not ours.
 * 5. PANE mode (`<leader>w`), while active, takes every key; a key it does
 *    not know ends it and continues below.
 * 6. Normal or visual mode: a pending surface sequence (Vim's `g`, `f`, an
 *    operator) first; then the keymap for the leader or a pending sequence;
 *    then the scope's surface; then the keymap's other root keys; then, in
 *    the chat, any printable key is swallowed so it never types into the
 *    composer.
 */

export interface KeySurface {
  readonly scope: KeyScope;
  /** The trie mode the surface is in. */
  mode(): KeyMode;
  label(): EngineModeLabel;
  /** Mid-sequence inside the surface's own grammar (Vim `g`, `f`, operators). */
  isPending(): boolean;
  /** Returns true when the surface consumed the key. */
  handleKey(token: string, event: KeyboardEvent): boolean;
  runCommand?(command: string, count: number | null): boolean;
  reset(): void;
}

const WHICH_KEY_DELAY_MS = 200;

const keymap = compileKeymap(DEFAULT_KEYMAP);
if (keymap.conflicts.length > 0 && import.meta.env.DEV) {
  console.warn("[keys] keymap conflicts", keymap.conflicts);
}

let enabled = false;
let sequence: SequenceState = IDLE_SEQUENCE;
let whichKeyTimer: number | null = null;
let helpOpen = false;
const surfaces = new Map<KeyScope, KeySurface>();
let installed = false;
/**
 * Where the keys went before the command palette took them, and the composer's
 * normal-mode cursor if it was in normal mode. Read when the palette closes;
 * opening it blurs the composer, which drops normal mode.
 */
let paletteOrigin: { readonly scope: KeyScope; readonly composerOffset: number | null } = {
  scope: "chat",
  composerOffset: null,
};

export function registerKeySurface(surface: KeySurface): () => void {
  surfaces.set(surface.scope, surface);
  return () => {
    if (surfaces.get(surface.scope) === surface) surfaces.delete(surface.scope);
  };
}

export function configureKeyEngine(options: { readonly enabled: boolean }): void {
  enabled = options.enabled;
  if (!enabled) resetEngine();
  updateKeyEngineSnapshot({ enabled });
  refreshModeIndicator();
}

export function installKeyEngine(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("keydown", onKeyDown, true);
  // The indicator follows focus, not just keys: clicking into the composer
  // is entering insert mode. Read after the surfaces' own focus listeners,
  // which run later and may change their mode.
  window.addEventListener("focusin", () => queueMicrotask(settleOnInput), true);
  window.addEventListener("focusout", () => queueMicrotask(refreshModeIndicator), true);
  // A click on a pane's text moves the keys there without focusing anything.
  // Where an element holds focus, the press blurs it next and `focusout`
  // refreshes; refreshing now would read that element's pane back first.
  window.addEventListener(
    "pointerdown",
    (event) => {
      notePointerPane(event.target);
      const active = document.activeElement;
      if (active === null || active === document.body) queueMicrotask(refreshModeIndicator);
    },
    true,
  );
}

function resetEngine(): void {
  sequence = IDLE_SEQUENCE;
  if (isPaneModeActive()) stopPaneMode();
  helpOpen = false;
  clearWhichKey();
  for (const surface of surfaces.values()) surface.reset();
}

function clearWhichKey(): void {
  if (whichKeyTimer !== null) {
    window.clearTimeout(whichKeyTimer);
    whichKeyTimer = null;
  }
  updateKeyEngineSnapshot({ whichKey: null, pending: [] });
}

function showWhichKey(node: KeyNode, title: string, immediately: boolean): void {
  if (whichKeyTimer !== null) window.clearTimeout(whichKeyTimer);
  const open = () => {
    whichKeyTimer = null;
    updateKeyEngineSnapshot({ whichKey: { title, rows: whichKeyRows(node) } });
  };
  if (immediately || readKeyEngineSnapshot().whichKey !== null) open();
  else whichKeyTimer = window.setTimeout(open, WHICH_KEY_DELAY_MS);
}

/** Shows where the keys go and in which mode; returns that scope, or null while off. */
export function refreshModeIndicator(): KeyScope | null {
  if (!enabled) {
    markChatBufferKeys(false);
    return null;
  }
  const scope = resolveKeyScope();
  markChatBufferKeys(scope === "chat");
  const surface = surfaces.get(scope);
  const mode: EngineModeLabel = isPaneModeActive()
    ? "PANE"
    : surface
      ? surface.label()
      : scope === "insert"
        ? "INSERT"
        : "NORMAL";
  updateKeyEngineSnapshot({ scope, mode });
  return scope;
}

/**
 * Marks the root while the chat buffer holds the keys, so the chat pane shows
 * its focus mark (`mesura.css`). Normal mode in the chat leaves focus on
 * <body>, where the column's `:focus-within` cannot see it.
 */
function markChatBufferKeys(on: boolean): void {
  const root = document.documentElement;
  if (root.hasAttribute("data-mesura-chat-keys") === on) return;
  if (on) root.dataset.mesuraChatKeys = "";
  else delete root.dataset.mesuraChatKeys;
}

/**
 * After a key and when focus lands: refreshes the indicator and records where
 * the keys go now, as the place a palette opened next returns to. Never when
 * focus merely leaves: the palette's opening blurs the composer to <body>
 * first, which would read as the chat.
 */
function settleOnInput(): void {
  const scope = refreshModeIndicator();
  if (scope === null || isCommandPaletteOpen()) return;
  paletteOrigin = {
    scope,
    composerOffset: scope === "composer" ? composerNormalOffset() : null,
  };
}

/**
 * For the command palette as it closes: puts the keys back where it was
 * opened from. The chat gets the keyboard back on `<body>` with its cursor
 * where it was; the composer in normal mode gets focus and normal mode at the
 * same cursor. Returns false when the palette's own focus target applies:
 * Vim mode off, or anywhere else, composer insert mode included.
 */
export function restorePaletteOrigin(): boolean {
  if (!enabled) return false;
  const { scope, composerOffset } = paletteOrigin;
  if (scope === "chat") {
    focusPane("chat");
  } else if (scope === "composer" && composerOffset !== null) {
    const editor = composerEditorElement();
    if (editor === null) return false;
    resumeComposerNormalOnFocus(composerOffset);
    editor.focus({ preventScroll: true });
  } else {
    return false;
  }
  // The palette is still in the page while it hands focus back.
  queueMicrotask(refreshModeIndicator);
  return true;
}

function consume(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

function onKeyDown(event: KeyboardEvent): void {
  if (!enabled) return;
  // Any key ends a composer resume the palette armed, before a command can
  // move focus back into the composer.
  cancelComposerNormalResume();
  if (event.isComposing || event.keyCode === 229) return;
  const token = keyTokenOf({
    key: event.key,
    code: event.code,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
    altGraph: event.getModifierState?.("AltGraph") ?? false,
  });
  if (token === null) return;
  if (readKeyEngineSnapshot().notice !== null) updateKeyEngineSnapshot({ notice: null });

  const scope = resolveKeyScope(deepActiveElement());
  try {
    if (handleKey(scope, token, event)) consume(event);
  } finally {
    settleOnInput();
  }
}

function handleKey(scope: KeyScope, token: string, event: KeyboardEvent): boolean {
  if (scope === "passthrough") {
    if (isPaneModeActive()) stopPaneMode();
    if (sequence !== IDLE_SEQUENCE) resetEngine();
    return false;
  }
  if (scope === "insert") {
    if (isPaneModeActive()) stopPaneMode();
    return false;
  }
  if (scope === "tree") {
    if (isPaneModeActive()) stopPaneMode();
    if (sequence.pending.length === 0 && token !== keymap.leader) return false;
    return stepKeymap(keymap.trieFor("normal", [getFocusedPane() ?? "panel"]), token, undefined);
  }
  if (isPaneModeActive() && handlePaneKey(token)) return true;

  const surface = surfaces.get(scope);
  const mode = surface?.mode() ?? "normal";

  if (scope === "composer" && (surface === undefined || mode === "insert")) {
    return surface?.handleKey(token, event) ?? false;
  }

  if (helpOpen) {
    helpOpen = false;
    clearWhichKey();
    if (token === "<Esc>") return true;
  }

  if (sequence.pending.length === 0 && surface?.isPending()) {
    return surface.handleKey(token, event);
  }

  // The leader and a pending sequence always belong to the keymap. Other
  // keys go to the surface's own grammar first (Vim motions in the chat and
  // the composer), and only then to the keymap, so a global `i` never steals
  // the composer's own `i` or a visual-mode `iw`.
  const trie = keymap.trieFor(mode, [scope]);
  if (sequence.pending.length > 0 || token === keymap.leader) {
    return stepKeymap(trie, token, surface);
  }
  if (surface?.handleKey(token, event)) return true;
  if (trie.children.has(token)) return stepKeymap(trie, token, surface);

  // Type-to-focus is gone in Vim mode: a printable key in the chat is a
  // command or nothing, never text for the composer.
  return scope === "chat" && token.length === 1;
}

function stepKeymap(trie: KeyNode, token: string, surface: KeySurface | undefined): boolean {
  const step = stepSequence(trie, sequence, token);
  sequence = step.state;
  const outcome = step.outcome;
  switch (outcome.kind) {
    case "pending":
      updateKeyEngineSnapshot({ pending: sequence.pending });
      showWhichKey(outcome.node, outcome.node.label ?? sequence.pending.join(""), false);
      return true;
    case "count":
      updateKeyEngineSnapshot({ pending: sequence.pending });
      return true;
    case "cancelled":
      clearWhichKey();
      return true;
    case "unbound":
      clearWhichKey();
      updateKeyEngineSnapshot({ notice: `${outcome.keys.join("")} is not mapped` });
      return true;
    case "command":
      clearWhichKey();
      runCommand(outcome.command, outcome.count, surface);
      return true;
  }
}

function runCommand(command: string, count: number | null, surface: KeySurface | undefined): void {
  if (isEngineCommand(command)) {
    switch (command) {
      case "composer.insert":
      case "composer.append":
        focusComposerAtEnd();
        return;
      case "keys.help": {
        const scope = resolveKeyScope();
        helpOpen = true;
        showWhichKey(
          keymap.trieFor(surfaces.get(scope)?.mode() ?? "normal", [scope]),
          "keys",
          true,
        );
        return;
      }
      case "composer.toggleExpanded":
        toggleComposerExpanded();
        return;
      case "pane.resizeMode":
        startPaneMode();
        return;
      case "chat.previousUserMessage":
      case "chat.nextUserMessage": {
        // Reaching a message is moving to the chat: leave the composer first.
        const chat = surfaces.get("chat");
        if (surface !== chat) (document.activeElement as HTMLElement | null)?.blur?.();
        chat?.runCommand?.(command, count);
        return;
      }
      default:
        surface?.runCommand?.(command, count);
        return;
    }
  }
  // App commands run through the handler their owner registered. No owner
  // mounted means the command does not apply where the developer is.
  if (!runRegisteredCommand(command as KeybindingCommand)) {
    updateKeyEngineSnapshot({ notice: `${command} is not available here` });
  }
}

/** Puts the caret at the end of the composer, which is entering insert mode. */
export function focusComposerAtEnd(): boolean {
  const editor = composerEditorElement();
  if (editor === null) return false;
  editor.focus({ preventScroll: true });
  const selection = window.getSelection();
  if (selection) {
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return true;
}
