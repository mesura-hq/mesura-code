/**
 * What a virtualiser needs before anything has been laid out.
 *
 * Extracted from `FileList`, which is where both of these were written and
 * where a second consumer then had to import them from. Two components reading
 * a listing component's internals is the coupling CLAUDE.md's DRY section says
 * to break rather than accept: a change to how a file list measures itself
 * should not be able to reach the spreadsheet pane.
 */

/**
 * The window to assume before the container has been measured.
 *
 * Not only for tests. A virtualiser with no measurement yet renders zero rows,
 * so the first frame after mount is blank until layout settles — and in a
 * headless DOM, where `getBoundingClientRect` always returns zeros, it never
 * settles and nothing renders at all. Assuming a plausible viewport gives the
 * first paint something real and makes the component testable without faking
 * layout.
 */
export const INITIAL_RECT = { width: 400, height: 800 };

/**
 * Report the element's size, falling back when it has none.
 *
 * A container that has not laid out yet measures zero, and a virtualiser told
 * its viewport is zero pixels tall renders zero rows. In production that is a
 * blank first frame; under a headless DOM, which has no layout engine at all
 * and always reports zero, it is a permanently empty list.
 *
 * Substituting a plausible viewport for a degenerate one keeps the component
 * honest in both: real measurements are used the moment they exist.
 */
export function observeWithFallback(
  instance: { scrollElement: Element | Window | null },
  cb: (rect: { width: number; height: number }) => void,
): (() => void) | undefined {
  const element = instance.scrollElement;
  if (element === null || !(element instanceof Element)) {
    cb(INITIAL_RECT);
    return undefined;
  }

  const report = () => {
    const { width, height } = element.getBoundingClientRect();
    cb(height > 0 ? { width, height } : INITIAL_RECT);
  };

  report();
  if (typeof ResizeObserver === "undefined") return undefined;

  const observer = new ResizeObserver(report);
  observer.observe(element);
  return () => observer.disconnect();
}

/**
 * A virtualised list of entries.
 *
 * Virtualisation is necessary and **not sufficient**. The measured lesson from
 * the Qt file tree is that the dominant cost was the NUMBER of directories
 * expanded, not the cost of rendering each row: a repository went from 3994 ms
 * to 449 ms by expanding three directories instead of a hundred, and row
 * rendering was never the bottleneck. Miller columns are safe by construction —
 * they show three levels and never expand a subtree — and decision D5 removed
 * automatic expansion entirely. This component handles the other half.
 */
