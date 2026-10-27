import type { EditorHighlightDefinition } from "@t3tools/contracts";

/**
 * Neovim's highlight attributes as CSS. Read from `hl_attr_define` by id, not mapped from group
 * names, because the drawing refers to an id only and every plugin's groups arrive the same way.
 * Scoped by a per-editor prefix class: two Neovims give id 7 two meanings.
 */

/** The class a cell carries so a rule can find it. */
export function highlightClassName(id: number | string): string {
  return `mesura-nvim-hl-${id}`;
}

/**
 * A colour, as Neovim packs it.
 *
 * An integer, which does not remember its leading zeroes — `0x00ff00` written
 * out plainly is `ff00`, four digits, and CSS reads that as a different colour
 * entirely rather than as an error.
 */
function cssColour(value: number): string {
  return `#${(value & 0xffffff).toString(16).padStart(6, "0")}`;
}

export function highlightRule(
  prefix: string,
  id: number | string,
  definition: EditorHighlightDefinition,
): string {
  const declarations: string[] = [];

  // `reverse` is the attribute a naive reading drops, and it is the one Vim's
  // own `Search` and `IncSearch` are usually defined with: a reversed pair
  // drawn unreversed paints a match in exactly the colours of the text around
  // it, which shows the developer nothing.
  const foreground = definition.reverse === true ? definition.bg : definition.fg;
  const background = definition.reverse === true ? definition.fg : definition.bg;
  if (foreground !== undefined) declarations.push(`color: ${cssColour(foreground)}`);
  if (background !== undefined) declarations.push(`background-color: ${cssColour(background)}`);

  if (definition.bold === true) declarations.push("font-weight: bold");
  if (definition.italic === true) declarations.push("font-style: italic");
  if (definition.undercurl === true) declarations.push("text-decoration: underline wavy");
  else if (definition.underline === true) declarations.push("text-decoration: underline");

  // `.monaco-editor` in the selector so a rule outranks Monaco's own token
  // colours (`.monaco-editor .mtkN`) instead of tying with them and depending
  // on which stylesheet happened to load last.
  const selector = `.monaco-editor .${highlightClassName(id)}`;
  const rule = `.${prefix} ${selector} { ${declarations.join("; ")} }`;
  if (background !== undefined) return rule;
  // While flash waits for a label, every highlight without a background fades (its backdrop, and on
  // purpose anything else drawn that way). Matches and labels have a background and stay full.
  return `${rule}\n.${prefix}.${NVIM_JUMPING_CLASS} ${selector} { opacity: ${JUMPING_BACKDROP_OPACITY} }`;
}

/** Set on the editor's container while flash is labelling targets. */
export const NVIM_JUMPING_CLASS = "mesura-nvim-jumping";

const JUMPING_BACKDROP_OPACITY = 0.4;

export function highlightStylesheet(
  prefix: string,
  definitions: Readonly<Record<string, EditorHighlightDefinition>>,
): string {
  return Object.entries(definitions)
    .map(([id, definition]) => highlightRule(prefix, id, definition))
    .join("\n");
}
