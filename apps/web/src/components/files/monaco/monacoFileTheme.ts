import type * as Monaco from "monaco-editor";

export const MESURA_MONACO_LIGHT = "mesura-light";
export const MESURA_MONACO_DARK = "mesura-dark";

export interface CodeSurfaceColors {
  readonly background: string;
  readonly foreground: string;
}

export interface CodeFont {
  readonly family: string;
  readonly sizePx: number;
}

const FALLBACK_FONT_SIZE_PX = 13;

/**
 * Reads the app's code-surface colours off a mounted element.
 *
 * Taken from the element rather than from the token names because the tokens
 * resolve differently under a custom theme: `--code-background` is a colour-mix
 * of other tokens by default, and an app theme overrides it with a flat value.
 * Asking the browser for the computed value is the only way to get what the
 * user is actually looking at.
 */
export function readCodeSurfaceColors(element: Element): CodeSurfaceColors {
  const computed = getComputedStyle(element);
  return { background: computed.backgroundColor, foreground: computed.color };
}

/** Reads the configured code font, which the appearance settings write to the root. */
export function readCodeFont(root: HTMLElement = document.documentElement): CodeFont {
  const computed = getComputedStyle(root);
  const family = computed.getPropertyValue("--font-mono").trim();
  const sizePx = Number.parseFloat(computed.getPropertyValue("--font-size-code"));
  return {
    family: family === "" ? "monospace" : family,
    sizePx: Number.isFinite(sizePx) && sizePx > 0 ? sizePx : FALLBACK_FONT_SIZE_PX,
  };
}

/**
 * Defines the two themes the file surface uses.
 *
 * They inherit Monaco's own `vs` and `vs-dark` token colours and override only
 * the surface, so the editor sits on the app's background instead of Monaco's.
 * Matching the token palette to the shiki themes the diff surfaces use is a
 * separate job and is not attempted here: following light and dark is the
 * requirement, and palette parity is not.
 */
export function defineMesuraMonacoThemes(
  monaco: typeof Monaco,
  colors: { readonly light: CodeSurfaceColors; readonly dark: CodeSurfaceColors },
): void {
  for (const [name, base, surface] of [
    [MESURA_MONACO_LIGHT, "vs", colors.light],
    [MESURA_MONACO_DARK, "vs-dark", colors.dark],
  ] as const) {
    monaco.editor.defineTheme(name, {
      base,
      inherit: true,
      rules: [],
      colors: {
        "editor.background": surface.background,
        "editor.foreground": surface.foreground,
        "editorGutter.background": surface.background,
        "editorLineNumber.foreground": surface.foreground,
      },
    });
  }
}
