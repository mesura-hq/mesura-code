/**
 * Whether the file panel hands its keys to Neovim.
 *
 * A constant until phase 8 turns it into a client setting. It is here rather
 * than inline so that the one place to change is obvious, and so the surface
 * reads the same before and after the setting exists.
 */
export const MODAL_EDITING_DEFAULT = true;
