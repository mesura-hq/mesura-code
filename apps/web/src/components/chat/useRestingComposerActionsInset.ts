import { useLayoutEffect, useState } from "react";

/** Reserves `pixels` at the row's right end, or clears the reserve for `null`. */
function writeRowRightInset(row: HTMLElement, pixels: number | null): void {
  if (pixels === null) {
    row.style.removeProperty("padding-right");
  } else {
    row.style.paddingRight = `${pixels}px`;
  }
}

/**
 * Keeps the resting composer's prompt row clear of the footer actions.
 *
 * In the resting layout the footer floats over the right end of the prompt row,
 * and its width follows the context pill's labels (`3.2k ◯ 1M`, a red
 * `190k ◯ 200k`) plus whichever of attach, dictation and send are shown. A
 * fixed `pr-*` class cannot match every combination, so the row reserves the
 * footer's measured extent as right padding. The padding is written straight
 * to the element: a resize re-measures without re-rendering the composer.
 *
 * Attach `rowRef` to the prompt row and `footerRef` to the footer.
 */
export function useRestingComposerActionsInset(active: boolean) {
  const [row, rowRef] = useState<HTMLElement | null>(null);
  const [footer, footerRef] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!row) return;
    if (!active || !footer) {
      writeRowRightInset(row, null);
      return;
    }
    const reserveFooterExtent = () => {
      // The footer's own left padding already separates the text from the
      // first control, so no extra gap is added.
      const reserved = row.getBoundingClientRect().right - footer.getBoundingClientRect().left;
      writeRowRightInset(row, Math.max(0, Math.ceil(reserved)));
    };
    reserveFooterExtent();
    if (typeof ResizeObserver === "undefined") {
      return () => writeRowRightInset(row, null);
    }
    const observer = new ResizeObserver(reserveFooterExtent);
    // Border boxes, so the padding written here does not re-trigger the observer.
    observer.observe(row, { box: "border-box" });
    observer.observe(footer, { box: "border-box" });
    return () => {
      observer.disconnect();
      writeRowRightInset(row, null);
    };
  }, [active, row, footer]);

  return { rowRef, footerRef };
}
