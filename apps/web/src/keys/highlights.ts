/**
 * Paints ranges with the CSS Custom Highlight API: no DOM changes, so the
 * virtualized timeline never re-renders for a cursor move. Styles live in
 * `mesura.css` under `::highlight(<name>)`. The citation source highlight in
 * `AssistantCitationSource.tsx` is the precedent.
 */

export type HighlightName =
  | "mesura-chat-cursor"
  | "mesura-flash-match"
  | "mesura-flash-backdrop"
  | "mesura-composer-cursor"
  | "mesura-composer-visual";

function registry(): HighlightRegistry | null {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined"
    ? CSS.highlights
    : null;
}

/**
 * The order highlights stack in where they overlap: the higher one paints
 * over the lower. Flash matches sit over the flash backdrop, and the cursors
 * over both.
 */
const PRIORITY: Readonly<Record<HighlightName, number>> = {
  "mesura-flash-backdrop": 0,
  "mesura-flash-match": 1,
  "mesura-composer-visual": 2,
  "mesura-chat-cursor": 3,
  "mesura-composer-cursor": 3,
};

export function paintHighlight(name: HighlightName, ranges: readonly Range[]): void {
  const highlights = registry();
  if (highlights === null) return;
  if (ranges.length === 0) {
    highlights.delete(name);
    return;
  }
  const highlight = new Highlight(...ranges);
  highlight.priority = PRIORITY[name];
  highlights.set(name, highlight);
}
