/**
 * One key press in Vim notation. Printable glyphs never carry Shift: on the Latin-American layout `/`
 * is Shift+7, and keeping Shift made `/` unmatchable (the same bug broke Symmetria's Qt slash-search).
 * Browsers report AltGr as Ctrl+Alt, so a glyph typed with AltGr is the glyph alone, never `<C-M-@>`.
 */

export interface KeyPress {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly altGraph: boolean;
}

const NAMED_KEYS: Readonly<Record<string, string>> = {
  " ": "Space",
  Escape: "Esc",
  Enter: "CR",
  Backspace: "BS",
  Tab: "Tab",
  Delete: "Del",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
};

const BARE_MODIFIERS = new Set([
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "OS",
  "Super",
  "Hyper",
  "CapsLock",
  "Dead",
  "Unidentified",
  "Process",
]);

/** The Latin letter at the physical position, for Ctrl chords on non-Latin layouts. */
function physicalLetter(code: string): string | null {
  const match = /^Key([A-Z])$/.exec(code);
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * The token for a key press, or null when the press is not ours to read: a bare
 * modifier, a dead key, or any chord holding Super/Cmd, which belongs to the
 * window manager.
 */
export function keyTokenOf(press: KeyPress): string | null {
  if (BARE_MODIFIERS.has(press.key)) return null;
  if (press.metaKey) return null;

  const named = NAMED_KEYS[press.key];
  const printable = named === undefined && press.key.length === 1;
  const altGraphGlyph = printable && press.altGraph;

  const ctrl = press.ctrlKey && !altGraphGlyph;
  const alt = press.altKey && !altGraphGlyph;

  if (printable && !ctrl && !alt) return press.key;

  let base: string;
  if (named !== undefined) {
    base = named;
  } else if (printable) {
    // With Ctrl or Alt held the produced glyph is unreliable across layouts;
    // prefer the physical Latin letter, as `apps/web/src/keybindings.ts` does.
    base = physicalLetter(press.code) ?? press.key.toLowerCase();
  } else {
    base = press.key;
  }

  const modifiers = [
    ctrl ? "C" : null,
    alt ? "M" : null,
    // Shift only survives on named keys and letters under another modifier.
    press.shiftKey && (named !== undefined || ctrl || alt) ? "S" : null,
  ].filter((modifier) => modifier !== null);

  if (modifiers.length === 0) return `<${base}>`;
  return `<${modifiers.join("-")}-${base}>`;
}

/**
 * Splits a key sequence written in Vim notation into tokens.
 * `<leader>` expands to the leader token.
 *
 * `"<leader>tr"` → `["<Space>", "t", "r"]`, `"gg"` → `["g", "g"]`.
 */
export function parseKeySequence(sequence: string, leader = "<Space>"): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < sequence.length) {
    const char = sequence[index]!;
    if (char === "<") {
      const close = sequence.indexOf(">", index + 1);
      if (close > index + 1) {
        const inner = sequence.slice(index + 1, close);
        tokens.push(inner.toLowerCase() === "leader" ? leader : normaliseBracketToken(inner));
        index = close + 1;
        continue;
      }
    }
    tokens.push(char);
    index += 1;
  }
  return tokens;
}

/** `<c-d>` → `<C-d>`, `<esc>` → `<Esc>`, `<space>` → `<Space>`. */
function normaliseBracketToken(inner: string): string {
  const parts = inner.split("-");
  const base = parts.pop()!;
  const modifiers = parts.map((part) => part.toUpperCase());
  const known = Object.values(NAMED_KEYS).find((name) => name.toLowerCase() === base.toLowerCase());
  const normalisedBase = known ?? base;
  if (modifiers.length === 0) return `<${normalisedBase}>`;
  return `<${modifiers.join("-")}-${normalisedBase}>`;
}

/** How a token is shown in which-key and the mode indicator. */
export function displayToken(token: string, leader = "<Space>"): string {
  if (token === leader) return "␣";
  return token;
}
