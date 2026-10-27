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
 * The scratch surface `toMonacoColor` paints on. One canvas for the process: `willReadFrequently`
 * gives a software-backed surface, right for many one-pixel reads and wrong for a throwaway canvas.
 */
let colorProbe: CanvasRenderingContext2D | null | undefined;

/**
 * Test-only: throws the memoised probe canvas away, so a test's fake `document` is used rather than
 * the first test's fake. The defect these tests catch is a canvas carrying state between reads.
 */
export function resetColorProbeForTest(): void {
  colorProbe = undefined;
}

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
 * Resolves any CSS colour to the `#rrggbb` Monaco requires: Monaco's theme registry throws on the
 * app's `oklch(...)` colours and takes the panel down on mount. A one-pixel canvas paint does the
 * conversion. Every failure returns the fallback, because a throw here would crash the panel again.
 */
function toMonacoColor(cssColor: string, fallback: string): string {
  return paintedColor(cssColor) ?? fallback;
}

/**
 * The colour a CSS value paints, or `null` when it paints nothing (no sentinel colour a theme could
 * really use). Limitation: partial alpha reports the colour alone, not composited over what is
 * behind it; only full transparency continues the walk. Surfaces read today are opaque or absent.
 */
function paintedColor(cssColor: string): string | null {
  const context = colorProbeContext();
  if (context === null) return null;
  // Cleared first: the canvas outlives the call, and a translucent input composites over the last
  // colour read. Uncleared, a transparent background read back as the previous colour.
  context.clearRect(0, 0, 1, 1);
  // An unparseable value leaves `fillStyle` untouched. Seeded transparent, so
  // a colour the browser cannot read answers "nothing painted" rather than
  // whatever the seed happened to be.
  context.fillStyle = "rgba(0, 0, 0, 0)";
  context.fillStyle = cssColor;
  context.fillRect(0, 0, 1, 1);
  try {
    const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
    // Transparent is not a colour Monaco can use, and it is not an error
    // either: it means the element paints nothing and the answer is somewhere
    // above it. The caller decides what to do with the fallback.
    if ((alpha ?? 0) === 0) return null;
    return `#${[red, green, blue].map((channel) => (channel ?? 0).toString(16).padStart(2, "0")).join("")}`;
  } catch {
    // `getImageData` is the one call here that throws: a tainted canvas, or a
    // browser that treats a pixel read as a fingerprinting attempt and blocks
    // it. Neither is recoverable, and neither is worth a crash.
    return null;
  }
}

/**
 * Reads the code-surface colours off a mounted element, because an app theme can override the
 * tokens (`--code-background` is a colour-mix by default) and only the computed value is what the
 * user sees.
 */
export function readCodeSurfaceColors(element: Element): CodeSurfaceColors {
  const computed = getComputedStyle(element);
  return {
    background: readPaintedBackground(element, computed),
    foreground: toMonacoColor(computed.color, "#000000"),
  };
}

/**
 * The colour actually behind an element. `backgroundColor` is not inherited and the editor host
 * paints none, so this walks up the ancestors as the browser does when painting; the document
 * element is the last stop.
 */
function readPaintedBackground(element: Element, computed: CSSStyleDeclaration): string {
  let current: Element | null = element;
  let style: CSSStyleDeclaration = computed;
  while (current !== null) {
    const painted = paintedColor(style.backgroundColor);
    if (painted !== null) return painted;
    current = current.parentElement;
    if (current === null) break;
    style = getComputedStyle(current);
  }
  // Nothing in the chain paints anything, which should not happen — the
  // document element has a background by construction. Answering white
  // regardless would put a dark app's editor on white, so follow the scheme
  // the page declares.
  return document.documentElement.classList.contains("dark") ? "#000000" : "#ffffff";
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
 * Defines the file surface's two themes: Monaco's `vs` and `vs-dark` token colours with only the
 * surface overridden to the app's background. Matching the diff surfaces' shiki palette is out of
 * scope; following light and dark is the requirement.
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
