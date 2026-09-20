/**
 * The scrollbar, as one definition.
 *
 * Chromium's default is wide, white, and carries an arrow button at each end.
 * Over a near-black window it is the loudest thing on screen, and it appeared
 * in three places at once inside a previewed HTML page while the file list
 * beside it drew the quiet lane this application actually uses.
 *
 * ── Why a shared module and not just a stylesheet ───────────────────────────
 * A stylesheet reaches one document. There are TWO documents on screen: the
 * panel, and whatever HTML file the preview is framing. A framed document has
 * its own cascade and cannot see a single declaration of the panel's — so the
 * rules have to travel to it, as text, in the response the main process
 * serves. That is what this module is for.
 *
 * `fm-ui`'s `styles.css` holds the same six rules for the panel, because CSS
 * loaded as CSS paints before any script runs and moving it into JavaScript
 * would trade a real property for a tidiness one. `theme.test.ts` compares the
 * two declaration by declaration and fails when they drift, which is the part
 * that makes "one definition" true rather than merely intended.
 *
 * ── The obvious way to remove the duplication does not work here ────────────
 * A review proposed one shared `scrollbar.css`, `@import`ed by the panel and
 * pulled into this module as text with Vite's `?raw`. It was tried and
 * rejected before this file existed, and the reason is not visible from the
 * source: **the main process is bundled by esbuild**, not by Vite — see
 * `app/scripts/build.mjs`, which says why — and esbuild does not understand
 * the `?raw` suffix. Vitest, which runs the tests, DOES resolve it, so the
 * arrangement would type-check and pass every test and fail only in the
 * shipped bundle. Reviving it means either giving esbuild a `.css` text loader
 * and teaching vitest the same resolution, or moving the main build to Vite.
 * Neither is wrong; both are larger than this, and the drift test is what
 * makes waiting safe.
 */

/**
 * The six rules, written against tokens rather than values.
 *
 * Unscoped on purpose. Every surface that scrolls gets this, in either
 * document — a rule per class means remembering to add the next one, and in a
 * framed document there are no class names to name.
 *
 * `::-webkit-scrollbar-button` is the one people forget. Without it the thumb
 * and the track are restyled and the two little arrows stay, which reads as a
 * half-finished theme rather than as a deliberate one.
 */
export const SCROLLBAR_RULES = `
::-webkit-scrollbar {
  width: var(--scrollbar-width);
  height: var(--scrollbar-width);
}

::-webkit-scrollbar-track {
  background: var(--scrollbar-track);
}

::-webkit-scrollbar-thumb {
  border-radius: var(--radius-sm);
  background: var(--scrollbar-thumb);
}

::-webkit-scrollbar-thumb:hover {
  background: var(--scrollbar-thumb-hover);
}

::-webkit-scrollbar-button {
  display: none;
}

::-webkit-scrollbar-corner {
  background: var(--scrollbar-track);
}
`;

/**
 * The values for a document that has never heard of this application.
 *
 * A framed page carries no `tokens.css`, so the rules above would resolve to
 * nothing at all there — a `var()` with no declaration and no fallback drops
 * the whole declaration silently. These supply them.
 *
 * ── One value differs from the panel's, and it is the TRACK ─────────────────
 * The panel paints its track `transparent` so its own column surface runs
 * under the lane. **In a framed document transparent is the one value that
 * cannot be used.** Measured against Chromium 41: once a track carries author
 * styles, it composites against the FRAME's own white base — not against the
 * page. The previewed page cannot reach it, with a background on its `body`
 * or on its `html`; both were tried and both left the same white stripe down a
 * dark page. That stripe is worse than the default scrollbar it replaced.
 *
 * So the track is painted here, solid, in the panel's own base colour. That
 * one substitution is what lets every other value be the panel's exactly: with
 * a known near-black substrate under it, the panel's 8%-white thumb reads in a
 * previewed page precisely as it reads in the file list beside it. The lane
 * belongs to the panel rather than to the page, which is the whole point — it
 * is the same lane in both, not two that resemble each other.
 *
 * None of these four is a free value. `theme.test.ts` pins the width, the
 * corner and both thumb colours to `tokens.css`, and pins the track to the
 * `--background` declared there.
 */
export const FOREIGN_DOCUMENT_TOKENS = `
:root {
  --scrollbar-width: 6px;
  --radius-sm: 4px;
  --scrollbar-track: oklch(14.5% 0 0);
  --scrollbar-thumb: rgb(255 255 255 / 8%);
  --scrollbar-thumb-hover: rgb(255 255 255 / 12%);
}
`;

/**
 * The whole thing as one element, ready to append to a served HTML document.
 *
 * A `<style>` and not a stylesheet link: a link would be a second request under
 * a content policy that grants `'self'` and would have to be served from the
 * same grant as the page, for no gain over 400 bytes inline.
 */
export const FOREIGN_DOCUMENT_STYLE = `<style>${FOREIGN_DOCUMENT_TOKENS}${SCROLLBAR_RULES}</style>`;
