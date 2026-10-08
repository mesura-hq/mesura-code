import { getFocusedPane, getLastFocusedPane } from "~/lib/paneFocus";
import { isCommandPaletteOpen } from "~/commandPaletteBus";

/**
 * Where a key press belongs, read from the DOM on every press and never
 * stored, the same rule ADR-004 uses for pane focus.
 */

export const COMPOSER_EDITOR_SELECTOR = '[data-testid="composer-editor"]';

/**
 * Surfaces that own every key they receive. The engine stands aside for them
 * completely, so the terminal, the Neovim editor, the file tree and any open
 * dialog or menu keep their own keyboard.
 */
const PASSTHROUGH_SELECTOR = [
  "[data-terminal-owner]",
  ".monaco-editor",
  '[role="tree"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[data-slot="combobox-popup"]',
  "[data-key-passthrough]",
].join(",");

/** Layers that may be open while focus stays behind them. */
const OPEN_LAYER_SELECTOR = [
  '[role="dialog"][aria-modal="true"]',
  '[data-slot="dialog-popup"]:is([data-open])',
  '[data-slot="sheet-popup"]:is([data-open])',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="popover-popup"]',
  '[data-slot="combobox-popup"]',
].join(",");

const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "url",
  "number",
  "password",
  "tel",
  "date",
  "",
]);

/**
 * Whether typing here produces text: Tridactyl's `isTextEditable` rules,
 * without its site-specific exceptions.
 */
export function isTextEditable(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.closest('[aria-disabled="true"]')) return false;
  if (element instanceof HTMLInputElement) {
    return !element.disabled && !element.readOnly && TEXT_INPUT_TYPES.has(element.type);
  }
  if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
  if (element instanceof HTMLSelectElement) return true;
  return element.isContentEditable;
}

/** The focused element, descending into open shadow roots (Vimium, Surfingkeys). */
export function deepActiveElement(): Element | null {
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

export type KeyScope = "composer" | "insert" | "passthrough" | "sidebar" | "chat" | "panel";

export function resolveKeyScope(active: Element | null = deepActiveElement()): KeyScope {
  // Read first, before any early return: `getFocusedPane` records the pane
  // that a later blur to <body> falls back to. Skipped for the composer, it
  // left the terminal recorded after a click from the terminal into the
  // composer, and `Esc Esc` then handed every key to the terminal's
  // passthrough instead of the chat.
  const focusedPane = getFocusedPane();
  if (isCommandPaletteOpen()) return "passthrough";
  if (active?.closest(COMPOSER_EDITOR_SELECTOR)) return "composer";
  if (active?.closest(PASSTHROUGH_SELECTOR)) return "passthrough";
  if (isTextEditable(active)) return "insert";
  if (document.querySelector(OPEN_LAYER_SELECTOR)) return "passthrough";
  const pane = focusedPane ?? getLastFocusedPane();
  if (pane === "terminal") return "passthrough";
  return pane;
}

export function composerEditorElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(COMPOSER_EDITOR_SELECTOR);
}

export function isComposerMenuOpen(): boolean {
  return document.querySelector("[data-composer-command-drawer]") !== null;
}
