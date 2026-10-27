/**
 * Browser key events in Neovim's key notation; `null` means the key goes on to Monaco and the app.
 * A printable character goes as itself and ignores modifier flags (on a Latin-American layout `/`
 * is Shift+7, and `<S-/>` means nothing to Neovim); a named key keeps Shift. Dead-key composition
 * (`Dead`, then keyCode 229) is never routed, or typing `á` gives `a`.
 */

export interface NvimKeyEvent {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly keyCode: number;
  readonly isComposing: boolean;
}

/** Keys with a name in Neovim's notation rather than a character. */
const SPECIAL_KEYS: Readonly<Record<string, string>> = {
  Escape: "<Esc>",
  Enter: "<CR>",
  Backspace: "<BS>",
  Tab: "<Tab>",
  Delete: "<Del>",
  ArrowUp: "<Up>",
  ArrowDown: "<Down>",
  ArrowLeft: "<Left>",
  ArrowRight: "<Right>",
  Home: "<Home>",
  End: "<End>",
  PageUp: "<PageUp>",
  PageDown: "<PageDown>",
  Insert: "<Insert>",
  F1: "<F1>",
  F2: "<F2>",
  F3: "<F3>",
  F4: "<F4>",
  F5: "<F5>",
  F6: "<F6>",
  F7: "<F7>",
  F8: "<F8>",
  F9: "<F9>",
  F10: "<F10>",
  F11: "<F11>",
  F12: "<F12>",
};

/** Keys that are only ever a modifier, and never a keystroke of their own. */
const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  "Control",
  "Shift",
  "Alt",
  "Meta",
  "CapsLock",
  "AltGraph",
  "NumLock",
  "ScrollLock",
]);

/**
 * The `keyCode` every browser reports while an input method is composing.
 *
 * It is the one reliable signal across browsers, and it is why this function
 * takes `keyCode` at all — the property is deprecated for every other purpose.
 */
const COMPOSING_KEY_CODE = 229;

export function toNvimKey(event: NvimKeyEvent): string | null {
  if (event.isComposing || event.keyCode === COMPOSING_KEY_CODE) return null;
  if (event.key === "Dead" || event.key === "Unidentified") return null;
  if (MODIFIER_KEYS.has(event.key)) return null;

  // Neovim has a `<D-` notation for this and using it would be a mistake: the
  // application's own shortcuts — the file picker, the command palette — are
  // reached with it, and an editor that swallowed them would take them away
  // wherever the editor happened to have focus.
  if (event.metaKey) return null;

  const special = SPECIAL_KEYS[event.key];

  // Shift is a modifier for a named key, never for a printable one (that arrives shifted in
  // `event.key`). `<S-Tab>` and `<Tab>` map to different things in Neovim. Escape is left out on
  // purpose: a Shift held a moment too long would otherwise strand the developer in insert mode.
  const shiftIsPartOfTheKey = event.shiftKey && special !== undefined && event.key !== "Escape";

  // `:help key-notation` writes them in this order, and Neovim accepts any:
  // `<C-S-Tab>` and `<S-C-Tab>` fire the same mapping, measured.
  const modifiers = `${shiftIsPartOfTheKey ? "S-" : ""}${event.ctrlKey ? "C-" : ""}${event.altKey ? "M-" : ""}`;

  if (modifiers !== "") {
    // Inside `<…>` the name loses its own brackets: `<C-` plus `CR`, not `<CR>`.
    const base = special === undefined ? event.key : special.slice(1, -1);
    if (base.length === 0) return null;
    return `<${modifiers}${base}>`;
  }

  if (special !== undefined) return special;
  if (event.key === " ") return "<Space>";
  // A literal `<` would open a key name, so it has the one escape Neovim gives.
  if (event.key === "<") return "<lt>";

  // Anything else with a name rather than a character — `BrightnessUp`,
  // `LaunchMail` — is not a keystroke Neovim has any use for.
  return event.key.length === 1 ? event.key : null;
}
