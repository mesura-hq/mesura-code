import type { Plugin } from "vite-plus";

/**
 * Monaco's action widget selects detail rows with a `:has()` that reads `style`, so Chromium re-checks
 * it on every inline-style change and upstream's `group-has-*` turns each into a subtree restyle.
 * Monaco empties the detail whenever it hides it (`actionList.js`), so `:not(:empty)` selects the same
 * rows without reading `style` (measured: style work -18%, the same as deleting the rule).
 */

export const MONACO_STYLE_ATTRIBUTE_HAS = ':has(.detail:not([style*="display: none"]))';
export const MONACO_EMPTY_DETAIL_HAS = ":has(.detail:not(:empty))";

const ACTION_WIDGET_CSS =
  /[\\/]monaco-editor[\\/]esm[\\/]vs[\\/]platform[\\/]actionWidget[\\/]browser[\\/]actionWidget\.css(?:\?.*)?$/;

/** Whether a module id is the Monaco stylesheet this plugin rewrites. */
export function isMonacoActionWidgetCss(id: string): boolean {
  return ACTION_WIDGET_CSS.test(id);
}

/** Returns the rewritten CSS, or null when Monaco no longer ships the rule. */
export function rewriteMonacoActionWidgetCss(css: string): string | null {
  if (!css.includes(MONACO_STYLE_ATTRIBUTE_HAS)) return null;
  return css.replaceAll(MONACO_STYLE_ATTRIBUTE_HAS, MONACO_EMPTY_DETAIL_HAS);
}

export function monacoActionWidgetCssPlugin(): Plugin {
  let isBuild = false;
  let rewroteRule = false;
  return {
    name: "mesura:monaco-action-widget-css",
    enforce: "pre",
    configResolved(config) {
      isBuild = config.command === "build";
    },
    transform(code, id) {
      if (!isMonacoActionWidgetCss(id)) return null;
      const rewritten = rewriteMonacoActionWidgetCss(code);
      if (rewritten === null) {
        this.warn(
          `${MONACO_STYLE_ATTRIBUTE_HAS} not found in ${id}; re-check Monaco's :has() rules`,
        );
        return null;
      }
      rewroteRule = true;
      return { code: rewritten, map: null };
    },
    buildEnd() {
      // Monaco is always in the production graph, so a build that never
      // rewrote the rule means the file moved or was renamed in a Monaco bump.
      if (isBuild && !rewroteRule) {
        this.warn(
          "Monaco's actionWidget.css was never rewritten; re-check apps/web/vite/monacoActionWidgetCss.ts",
        );
      }
    },
  };
}
