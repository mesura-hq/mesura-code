/**
 * One compositor-run opacity animation (`[data-mesura-cite-flash]` in `mesura.css`), removed when
 * it ends: no frame loop. Drawn in the cited text's timeline row from an anchor, as the widened
 * cursor is, so it moves and clips with the text. Mouse and key cites both go through
 * `citeAndFlash`, so each cite flashes once and looks the same.
 */

import type { AssistantCitation } from "@t3tools/contracts";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";

/** The animation's length in `mesura.css`, plus a margin; also the fallback when it never runs. */
const CITE_FLASH_REMOVE_AFTER_MS = 1100;

/** The timeline row a range is in: where its flash and the widened cursor are drawn. */
export function timelineRowOf(range: Range): HTMLElement | null {
  return range.startContainer.parentElement?.closest<HTMLElement>("[data-timeline-row-id]") ?? null;
}

/**
 * Hands the citation to `cite` and, when the composer takes it, flashes the
 * cited text. The flash is drawn from the captured range, which outlives the
 * native selection the caller clears afterwards.
 */
export function citeAndFlash(
  cite: (citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean,
  citation: AssistantCitation,
  sourceAnchor: AssistantCitationSourceAnchor,
): boolean {
  const cited = cite(citation, sourceAnchor);
  const row = cited ? timelineRowOf(sourceAnchor.range) : null;
  if (row) flashCitedRange(sourceAnchor.range, row);
  return cited;
}

export function flashCitedRange(range: Range, row: HTMLElement): void {
  const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
  if (rects.length === 0) return;
  const anchor = document.createElement("span");
  anchor.setAttribute("aria-hidden", "true");
  anchor.dataset.mesuraCiteFlash = "";
  row.append(anchor);
  const origin = anchor.getBoundingClientRect();
  for (const rect of rects) {
    const box = document.createElement("span");
    box.style.left = `${rect.left - origin.left}px`;
    box.style.top = `${rect.top - origin.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    anchor.append(box);
  }
  const remove = () => anchor.remove();
  anchor.addEventListener("animationend", remove, { once: true });
  // Reduced motion runs no animation, so no `animationend` comes.
  window.setTimeout(remove, CITE_FLASH_REMOVE_AFTER_MS);
}
