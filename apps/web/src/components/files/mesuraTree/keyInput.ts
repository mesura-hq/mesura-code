import { modsOf, normaliseKey } from "@symmetria/fm-core/keys/keyEvent";
import type { Mods } from "@symmetria/fm-core/keys/types";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * A key press, as the tree's and the overview's key tables read it.
 *
 * Deliberately not a DOM `KeyboardEvent`, so a table is testable without a
 * document and so the caller decides what "inside a text input" means.
 */
export interface KeyInput {
  readonly key: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
  /** AltGr, as the browser reports it; a symbol key typed through it still matches. */
  readonly altGraph: boolean;
  /** The search field, or any other input, owns every key while it has focus. */
  readonly inTextInput: boolean;
}

export interface Binding<Command> {
  readonly keys: ReadonlyArray<string>;
  /**
   * The file manager's modifier classes. `Symbol` is its wildcard for a
   * punctuation key that sits on a shifted or AltGr position on some layouts:
   * `/` is Shift+7 on a Latin-American keyboard.
   */
  readonly mods: ReadonlyArray<Mods>;
  readonly command: Command;
}

export function commandForKey<Command>(
  bindings: ReadonlyArray<Binding<Command>>,
  input: KeyInput,
): Command | null {
  if (input.inTextInput || input.meta) return null;
  const key = normaliseKey(input.key);
  const mods = modsOf(input);
  // A symbol row accepts Shift and AltGr, because that is how the key is
  // typed on some layouts, and refuses Ctrl and Alt chords, as the file
  // manager's `matchKey` does.
  const symbol = (!input.ctrl && !input.alt) || input.altGraph;
  const binding = bindings.find(
    (candidate) =>
      candidate.keys.includes(key) &&
      ((symbol && candidate.mods.includes("Symbol")) ||
        (mods !== null && candidate.mods.includes(mods))),
  );
  return binding?.command ?? null;
}

const TEXT_INPUT_SELECTOR = "input, textarea, select, [contenteditable=true]";

interface KeyRoute<Command> {
  /** The file manager's flash mode, which takes every key while active. */
  readonly flash: { readonly active: boolean; onKey(event: KeyboardEvent): boolean };
  readonly commandFor: (input: KeyInput) => Command | null;
  readonly onEscape: () => void;
  readonly onCommand: (command: Command) => void;
}

/**
 * Routes one key press from a host wrapper to a file manager command port.
 *
 * The same rules for the tree and the overview: flash first; a button or a
 * disclosure keeps its native activation; Escape inside a text field only
 * leaves the field, so the next Escape reaches the host; Escape elsewhere is
 * the host's; anything else goes through the command table.
 */
export function routeKey<Command>(
  event: ReactKeyboardEvent<HTMLElement>,
  route: KeyRoute<Command>,
): void {
  const target = event.target instanceof Element ? event.target : null;
  if (route.flash.active) {
    if (route.flash.onKey(event.nativeEvent)) {
      event.preventDefault();
      event.stopPropagation();
    }
    return;
  }
  if (target?.closest("button, summary") && (event.key === "Enter" || event.key === " ")) return;
  const inTextInput = target?.closest(TEXT_INPUT_SELECTOR) !== null;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    if (inTextInput) {
      if (target instanceof HTMLElement) target.blur();
      return;
    }
    route.onEscape();
    return;
  }
  const command = route.commandFor({
    key: event.key,
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
    altGraph: event.getModifierState("AltGraph"),
    inTextInput,
  });
  if (command === null) return;
  event.preventDefault();
  event.stopPropagation();
  route.onCommand(command);
}
