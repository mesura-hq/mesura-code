/** The attribute the layer's root carries; the guard below and the stylesheet both key off it. */
export const FILE_MANAGER_ROOT_ATTRIBUTE = "data-mesura-file-manager";

type Page = ParentNode | null;
const currentPage = (): Page => (typeof document === "undefined" ? null : document);

function findFileManagerRoot(page: Page): HTMLElement | null {
  return page?.querySelector<HTMLElement>(`[${FILE_MANAGER_ROOT_ATTRIBUTE}]`) ?? null;
}

/**
 * Whether the file manager is up over the window, read from the page at
 * event time the way `isCommandPaletteOpen` is, so no listener has to
 * subscribe to the store to know.
 */
export function isFileManagerOpen(page: Page = currentPage()): boolean {
  return findFileManagerRoot(page) !== null;
}

/** Gives the layer's root the keyboard when it is in the page; true when it took focus. */
export function focusFileManager(page: Page = currentPage()): boolean {
  const root = findFileManagerRoot(page);
  root?.focus({ preventScroll: true });
  return root !== null;
}
