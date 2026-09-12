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
 * The scratch surface `toMonacoColor` paints on.
 *
 * One canvas for the process, because every colour the app resolves goes
 * through it: `willReadFrequently` asks the browser for a software-backed
 * surface, which is the right trade for many one-pixel reads and the wrong one
 * for a canvas that is thrown away after a single read.
 */
let colorProbe: CanvasRenderingContext2D | null | undefined;

function colorProbeContext(): CanvasRenderingContext2D | null {
  if (colorProbe === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    colorProbe = canvas.getContext("2d", { willReadFrequently: true });
  }
  return colorProbe;
}

/**
 * Resolves any CSS colour to the `#rrggbb` Monaco insists on.
 *
 * This app's computed colours come back as `oklch(...)`, which Monaco's theme
 * registry rejects outright — it throws "Illegal value for token color", and
 * because the theme is defined while the editor mounts, the throw takes the
 * whole panel down rather than degrading to a wrong colour.
 *
 * A one-pixel canvas is the conversion: the browser already knows how to paint
 * every colour syntax it accepts, so painting one and reading the bytes back
 * needs no colour-space arithmetic here and cannot drift from what the rest of
 * the interface actually shows.
 *
 * Every failure answers with the fallback rather than throwing. This function
 * exists because a bad colour crashed the panel on mount, and a conversion that
 * can itself throw would reintroduce exactly that.
 */
function toMonacoColor(cssColor: string, fallback: string): string {
  const context = colorProbeContext();
  if (context === null) return fallback;
  // An unparseable value leaves `fillStyle` untouched, so seeding it with the
  // fallback means a bad colour paints the fallback rather than black.
  context.fillStyle = fallback;
  context.fillStyle = cssColor;
  context.fillRect(0, 0, 1, 1);
  try {
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    return `#${[red, green, blue].map((channel) => (channel ?? 0).toString(16).padStart(2, "0")).join("")}`;
  } catch {
    // `getImageData` is the one call here that throws: a tainted canvas, or a
    // browser that treats a pixel read as a fingerprinting attempt and blocks
    // it. Neither is recoverable, and neither is worth a crash.
    return fallback;
  }
}

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
  return {
    background: toMonacoColor(computed.backgroundColor, "#ffffff"),
    foreground: toMonacoColor(computed.color, "#000000"),
  };
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
