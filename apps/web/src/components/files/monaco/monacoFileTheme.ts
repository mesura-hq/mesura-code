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

/**
 * Throws the probe canvas away, so the next read builds a new one.
 *
 * For tests only. The canvas is memoised for the life of the process, so a
 * test that installs its own fake `document` gets the fake built by whichever
 * test ran first — every case then shares one pixel, and the isolation they
 * appear to have is not real. That matters here specifically: the defect these
 * tests exist to catch is a canvas carrying state between reads.
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
  return paintedColor(cssColor) ?? fallback;
}

/**
 * The colour a CSS value paints, or `null` when it paints nothing.
 *
 * `null` rather than a sentinel colour. A sentinel has to be a value no theme
 * would choose, which is a guess — and an element that genuinely painted it
 * would be read as transparent and walked past.
 *
 * Partial alpha is reported as the colour alone, not composited with whatever
 * is behind it: `rgba(0, 0, 0, 0.5)` over white answers black rather than the
 * grey on screen. Only full transparency continues the walk. Every surface
 * this reads today is opaque or absent, and compositing a chain of
 * translucent ancestors is more machinery than the case has earned — but it
 * is a limitation rather than a decision, and this is where it would go.
 */
function paintedColor(cssColor: string): string | null {
  const context = colorProbeContext();
  if (context === null) return null;
  // Cleared first, because the canvas outlives the call. A colour with any
  // transparency composites over whatever the previous call left on the pixel,
  // so a fully transparent input used to come back as the last colour read —
  // and an element with no background of its own is exactly that input. The
  // editor took its background from whichever colour happened to be read
  // before it.
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
    background: readPaintedBackground(element, computed),
    foreground: toMonacoColor(computed.color, "#000000"),
  };
}

/**
 * The colour actually behind an element.
 *
 * `backgroundColor` is not inherited, so an element that paints nothing
 * answers `rgba(0, 0, 0, 0)` however dark the page behind it is. The editor's
 * host is one of those — it is a flex box with no background of its own — so
 * asking it directly never described what the developer sees, and the editor
 * ended up on a colour of Monaco's choosing rather than the app's.
 *
 * Walking up is what the browser does to paint it, so it is what this does to
 * read it. The document element is the last stop and has one by construction.
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
