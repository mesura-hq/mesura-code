import type { EditorHighlightDefinition } from "@t3tools/contracts";

/**
 * Neovim's highlight attributes, as CSS.
 *
 * The colours are the developer's own colourscheme. They are read from
 * `hl_attr_define` rather than mapped from a group name, because the drawing
 * refers to an id and nothing else: flash's labels, the search highlight, a
 * plugin's own groups and the colourscheme's all arrive the same way, and a
 * host that recognised only the names it had heard of would draw the rest in
 * the wrong colours or not at all.
 *
 * Scoped by a per-editor prefix class, because two file panels on two threads
 * are two Neovims, and id 7 means something different in each.
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

  return `.${prefix} .${highlightClassName(id)} { ${declarations.join("; ")} }`;
}

export function highlightStylesheet(
  prefix: string,
  definitions: Readonly<Record<string, EditorHighlightDefinition>>,
): string {
  return Object.entries(definitions)
    .map(([id, definition]) => highlightRule(prefix, id, definition))
    .join("\n");
}
