import type { Plugin } from "vite-plus";

/**
 * Rewrites the one `:has()` in Monaco's CSS that reads the `style` attribute.
 *
 * Monaco's action widget (the code-action menu) lays out rows that carry a
 * detail line with
 * `.monaco-list-row.action:has(.detail:not([style*="display: none"]))`.
 * A `:has()` whose argument depends on `style` makes Chromium re-check it on
 * every inline-style change anywhere in the document, and upstream's
 * `group-has-*` utilities turn each re-check into a whole-subtree restyle. The
 * app writes inline styles constantly (list row positions, label animations),
 * so while this rule is loaded — from the first file opened until the window
 * closes — every thread switch pays for it.
 *
 * Monaco empties the detail whenever it hides it (`actionList.js` sets
 * `textContent = ''` with `display = 'none'`), so `:not(:empty)` selects the
 * same rows without reading `style`. Measured 2026-09-26 on the same data and
 * scripted thread switches: whole-page restyles 46 → 36, elements restyled
 * 104k → 84k, style work −18%, identical to deleting the rule.
 */

export const MONACO_STYLE_ATTRIBUTE_HAS = ':has(.detail:not([style*="display: none"]))';
export const MONACO_EMPTY_DETAIL_HAS = ":has(.detail:not(:empty))";

const ACTION_WIDGET_CSS =
  /[\\/]monaco-editor[\\/]esm[\\/]vs[\\/]platform[\\/]actionWidget[\\/]browser[\\/]actionWidget\.css(?:\?.*)?$/;

/** Returns the rewritten CSS, or null when Monaco no longer ships the rule. */
export function rewriteMonacoActionWidgetCss(css: string): string | null {
  if (!css.includes(MONACO_STYLE_ATTRIBUTE_HAS)) return null;
  return css.replaceAll(MONACO_STYLE_ATTRIBUTE_HAS, MONACO_EMPTY_DETAIL_HAS);
}

export function monacoActionWidgetCssPlugin(): Plugin {
  return {
    name: "mesura:monaco-action-widget-css",
    enforce: "pre",
    transform(code, id) {
      if (!ACTION_WIDGET_CSS.test(id)) return null;
      const rewritten = rewriteMonacoActionWidgetCss(code);
      if (rewritten === null) {
        // A Monaco bump changed the rule. Say so at build time instead of
        // silently shipping whatever replaced it; the guard test in
        // tests/unit/monaco-css-has.test.ts names what to check.
        this.warn(
          `${MONACO_STYLE_ATTRIBUTE_HAS} not found in ${id}; re-check Monaco's :has() rules`,
        );
        return null;
      }
      return { code: rewritten, map: null };
    },
  };
}
