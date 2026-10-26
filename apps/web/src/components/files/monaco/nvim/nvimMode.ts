/**
 * Neovim's `nvim_get_mode` codes, as a person would name them. Matched as prefixes, not exact
 * values (`no`, `nov` and `noV` are all an operator waiting for its motion).
 */

/** Visual block, which Neovim reports as the literal `Ctrl-V` character. */
const VISUAL_BLOCK = "\x16";

export function describeMode(mode: string): string {
  // Before the `n` cases: `no` is an operator pending, not normal mode, and it
  // is the one a developer most needs to see — it means the next key is a
  // motion that will delete or change something.
  if (mode.startsWith("no")) return "OPERATOR";
  if (mode.startsWith("i")) return "INSERT";
  if (mode.startsWith("R")) return "REPLACE";
  if (mode.startsWith("v")) return "VISUAL";
  if (mode.startsWith("V")) return "V-LINE";
  if (mode.startsWith(VISUAL_BLOCK)) return "V-BLOCK";
  if (mode.startsWith("c")) return "COMMAND";
  if (mode.startsWith("t")) return "TERMINAL";
  if (mode.startsWith("s") || mode.startsWith("S")) return "SELECT";
  // Everything left reads as normal mode, and the codes that land here are
  // normal-mode variants: `nt` is normal mode inside a terminal buffer, `niI`
  // is the normal mode one `Ctrl-O` reaches from insert. Checked against a
  // real Neovim rather than assumed.
  return "NORMAL";
}

/**
 * The caret shape for a mode: a block outside insert mode, as in vim, since it covers the character
 * `x` deletes. Replace mode keeps the block, because the next character lands on the one under it.
 */
export function caretStyleFor(mode: string): "block" | "line" {
  return mode.startsWith("i") ? "line" : "block";
}
