import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { keyTokenOf } from "@mesura/keys/keyToken";
import { compileKeymap, whichKeyRows, type KeyMode, type KeyNode } from "@mesura/keys/keymap";
import { IDLE_SEQUENCE, stepSequence, type SequenceState } from "@mesura/keys/sequence";

import { DEFAULT_KEYMAP, isEngineCommand } from "./defaultKeymap";
import {
  composerEditorElement,
  deepActiveElement,
  resolveKeyScope,
  type KeyScope,
} from "./focusScope";
import { isSyntheticKeybindingReplay, replayKeybindingCommand } from "./keybindingCommandBridge";
import {
  readKeyEngineSnapshot,
  updateKeyEngineSnapshot,
  type EngineModeLabel,
} from "./keyEngineStore";
import { toggleComposerExpanded } from "./composer/composerExpanded";
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
 * 1. Off, a composition in progress, or a replayed chord: not ours.
 * 2. A passthrough scope (terminal, Neovim editor, file tree, open dialog or
 *    menu, command palette): not ours.
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
let keybindings: ResolvedKeybindingsConfig = [];
let sequence: SequenceState = IDLE_SEQUENCE;
let whichKeyTimer: number | null = null;
let helpOpen = false;
const surfaces = new Map<KeyScope, KeySurface>();
let installed = false;

export function registerKeySurface(surface: KeySurface): () => void {
  surfaces.set(surface.scope, surface);
  return () => {
    if (surfaces.get(surface.scope) === surface) surfaces.delete(surface.scope);
  };
}

export function configureKeyEngine(options: {
  readonly enabled: boolean;
  readonly keybindings: ResolvedKeybindingsConfig;
}): void {
  enabled = options.enabled;
  keybindings = options.keybindings;
  if (!enabled) resetEngine();
  updateKeyEngineSnapshot({ enabled });
  refreshModeIndicator();
}

export function installKeyEngine(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("keydown", onKeyDown, true);
  // The indicator follows focus, not just keys: clicking into the composer
  // is entering insert mode.
  window.addEventListener("focusin", refreshModeIndicator, true);
  window.addEventListener("focusout", () => queueMicrotask(refreshModeIndicator), true);
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

export function refreshModeIndicator(): void {
  if (!enabled) return;
  const scope = resolveKeyScope();
  const surface = surfaces.get(scope);
  const mode: EngineModeLabel = isPaneModeActive()
    ? "PANE"
    : surface
      ? surface.label()
      : scope === "insert"
        ? "INSERT"
        : "NORMAL";
  updateKeyEngineSnapshot({ scope, mode });
}

function consume(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

function onKeyDown(event: KeyboardEvent): void {
  if (!enabled || isSyntheticKeybindingReplay(event)) return;
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
    refreshModeIndicator();
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
  if (!replayKeybindingCommand(keybindings, command as KeybindingCommand)) {
    updateKeyEngineSnapshot({ notice: `${command} has no chord to run` });
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
