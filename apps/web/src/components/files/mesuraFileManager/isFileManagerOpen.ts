/** The attribute the layer's root carries; the guard below and the stylesheet both key off it. */
export const FILE_MANAGER_ROOT_ATTRIBUTE = "data-mesura-file-manager";

/**
 * Whether the file manager is up over the window, read from the page at
 * event time the way `isCommandPaletteOpen` is, so no listener has to
 * subscribe to the store to know.
 */
export function isFileManagerOpen(
  page: ParentNode | null = typeof document === "undefined" ? null : document,
): boolean {
  return page !== null && page.querySelector(`[${FILE_MANAGER_ROOT_ATTRIBUTE}]`) !== null;
}
