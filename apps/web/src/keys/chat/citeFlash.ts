/**
 * A short flash over chat text that was just cited, so the reader sees what
 * went to the composer before the keys move there.
 *
 * One CSS animation of opacity on one element (`mesura.css`,
 * `[data-mesura-cite-flash]`), removed when it ends: no frame loop, and the
 * compositor runs it. It is drawn in the timeline row the text is in, from an
 * anchor at its static position, as the widened cursor is (`blockCursor.ts`),
 * so it moves and clips with the text if the timeline shifts while it shows.
 */

/** The animation's length in `mesura.css`, plus a margin; also the fallback when it never runs. */
const CITE_FLASH_REMOVE_AFTER_MS = 1100;

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
