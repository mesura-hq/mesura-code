/**
 * Neovim's mode codes, as a person would name them.
 *
 * Its own module rather than part of the driver so it can be tested without
 * standing up React, and because the status strip needs it without needing a
 * hook.
 *
 * The codes come from `nvim_get_mode`, which returns the short form: a letter,
 * sometimes two. They are matched as prefixes rather than exact values — `no`,
 * `nov` and `noV` are all an operator waiting for its motion — which keeps the
 * list short without lying about the codes it does not enumerate.
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
 * The caret shape for a mode.
 *
 * A block outside insert mode, as vim's own is: it covers the character the
 * cursor is *on*, which is what `x` deletes. A bar between characters would
 * make every normal-mode command look like it acted one place to the right.
 *
 * Replace mode keeps the block. It is not insert mode: the next character
 * typed lands *on* the one under the cursor rather than before it, which is
 * exactly what a block says and a bar denies.
 */
export function caretStyleFor(mode: string): "block" | "line" {
  return mode.startsWith("i") ? "line" : "block";
}
