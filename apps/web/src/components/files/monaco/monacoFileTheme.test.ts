import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  defineMesuraMonacoThemes,
  MESURA_MONACO_DARK,
  MESURA_MONACO_LIGHT,
  readCodeSurfaceColors,
  resetColorProbeForTest,
} from "./monacoFileTheme";

interface DefinedTheme {
  readonly name: string;
  readonly data: {
    base: string;
    inherit: boolean;
    rules: ReadonlyArray<unknown>;
    colors: Record<string, string>;
  };
}

/** Enough of Monaco to record what was defined, without importing it. */
function stubMonaco() {
  const defined: DefinedTheme[] = [];
  const monaco = {
    editor: {
      defineTheme: (name: string, data: DefinedTheme["data"]) => {
        defined.push({ name, data });
      },
    },
  };
  return { monaco, defined };
}

const COLORS = {
  light: { background: "rgb(250, 250, 250)", foreground: "rgb(20, 20, 20)" },
  dark: { background: "rgb(24, 24, 27)", foreground: "rgb(240, 240, 240)" },
};

describe("defineMesuraMonacoThemes", () => {
  it("defines one theme per appearance, on the matching Monaco base", () => {
    const { monaco, defined } = stubMonaco();

    defineMesuraMonacoThemes(monaco as never, COLORS);

    expect(defined.map((theme) => theme.name)).toEqual([MESURA_MONACO_LIGHT, MESURA_MONACO_DARK]);
    expect(defined[0]?.data.base).toBe("vs");
    expect(defined[1]?.data.base).toBe("vs-dark");
  });

  it("inherits Monaco's token colours and overrides only the surface", () => {
    const { monaco, defined } = stubMonaco();

    defineMesuraMonacoThemes(monaco as never, COLORS);

    for (const theme of defined) {
      // Palette parity with the diff surfaces is a separate job; following the
      // app's light and dark background is the requirement here.
      expect(theme.data.inherit).toBe(true);
      expect(theme.data.rules).toEqual([]);
    }
  });

  it("puts the app's own code-surface colours on each theme", () => {
    const { monaco, defined } = stubMonaco();

    defineMesuraMonacoThemes(monaco as never, COLORS);

    expect(defined[0]?.data.colors).toEqual({
      "editor.background": COLORS.light.background,
      "editor.foreground": COLORS.light.foreground,
      "editorGutter.background": COLORS.light.background,
      "editorLineNumber.foreground": COLORS.light.foreground,
    });
    expect(defined[1]?.data.colors["editor.background"]).toBe(COLORS.dark.background);
  });
});

/**
 * Where the editor's background comes from.
 *
 * Two faults, and each hid the other. The probe canvas lives for the process
 * and was never cleared, so a colour with any transparency composited over the
 * last one read; and the editor's host paints no background of its own, so it
 * answered transparent every time. The editor therefore sat on whichever
 * colour happened to have been read before it — neither the app's nor
 * Monaco's, and different depending on the order of calls.
 *
 * The canvas here is a fake, and it composites the way a real one does. That
 * is the point: a fake that ignored alpha would pass with the defect in place.
 */
describe("readCodeSurfaceColors", () => {
  // The canvas is memoised for the life of the process, so without this only
  // the first test's fake is ever used and all three share one pixel — which
  // is the very thing they are here to catch.
  beforeEach(resetColorProbeForTest);

  interface Pixel {
    r: number;
    g: number;
    b: number;
    a: number;
  }

  const parse = (css: string): Pixel | null => {
    const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(css.trim());
    if (match === null) return null;
    return {
      r: Number(match[1]),
      g: Number(match[2]),
      b: Number(match[3]),
      a: match[4] === undefined ? 1 : Number(match[4]),
    };
  };

  /** A one-pixel 2D context that composites source-over, as the browser does. */
  function fakeCanvasContext() {
    let pixel: Pixel = { r: 0, g: 0, b: 0, a: 0 };
    let fill: Pixel = { r: 0, g: 0, b: 0, a: 1 };
    return {
      set fillStyle(css: string) {
        // A value the browser cannot parse leaves `fillStyle` as it was, which
        // is what the fallback seeding in `toMonacoColor` relies on.
        const parsed = parse(css);
        if (parsed !== null) fill = parsed;
      },
      clearRect: () => {
        pixel = { r: 0, g: 0, b: 0, a: 0 };
      },
      fillRect: () => {
        const a = fill.a + pixel.a * (1 - fill.a);
        if (a === 0) {
          pixel = { r: 0, g: 0, b: 0, a: 0 };
          return;
        }
        const mix = (source: number, backdrop: number) =>
          Math.round((source * fill.a + backdrop * pixel.a * (1 - fill.a)) / a);
        pixel = { r: mix(fill.r, pixel.r), g: mix(fill.g, pixel.g), b: mix(fill.b, pixel.b), a };
      },
      getImageData: () => ({
        data: [pixel.r, pixel.g, pixel.b, Math.round(pixel.a * 255)],
      }),
    };
  }

  const elementPainting = (background: string, parent: Element | null = null) =>
    ({ parentElement: parent, __background: background }) as unknown as Element;

  const withBrowser = <A>(body: () => A): A => {
    const originalStyle = globalThis.getComputedStyle;
    const originalDocument = (globalThis as { document?: unknown }).document;
    const context = fakeCanvasContext();
    (globalThis as { document?: unknown }).document = {
      createElement: () => ({ width: 0, height: 0, getContext: () => context }),
    };
    globalThis.getComputedStyle = ((element: Element) =>
      ({
        backgroundColor: (element as unknown as { __background: string }).__background,
        color: "rgb(200, 200, 200)",
      }) as CSSStyleDeclaration) as typeof globalThis.getComputedStyle;
    try {
      return body();
    } finally {
      globalThis.getComputedStyle = originalStyle;
      (globalThis as { document?: unknown }).document = originalDocument;
    }
  };

  it("takes the colour the element itself paints", () => {
    const colors = withBrowser(() => readCodeSurfaceColors(elementPainting("rgb(10, 20, 30)")));
    expect(colors.background).toBe("#0a141e");
  });

  it("climbs to whatever is actually behind a transparent element", () => {
    // The real shape: the editor's host is a flex box with no background of
    // its own and the app's black is on an ancestor. Reading the host alone
    // described nothing the developer can see.
    const app = elementPainting("rgb(0, 0, 0)");
    const panel = elementPainting("rgba(0, 0, 0, 0)", app);
    const host = elementPainting("rgba(0, 0, 0, 0)", panel);

    expect(withBrowser(() => readCodeSurfaceColors(host).background)).toBe("#000000");
  });

  it("does not answer with the colour it was asked about last", () => {
    // One canvas serves the whole process. Reading an opaque colour and then a
    // transparent one gave the first colour back for the second, so the editor
    // took its background from whatever had been read before it.
    const app = elementPainting("rgb(0, 0, 0)");
    const colors = withBrowser(() => {
      readCodeSurfaceColors(elementPainting("rgb(255, 0, 0)"));
      return readCodeSurfaceColors(elementPainting("rgba(0, 0, 0, 0)", app));
    });
    expect(colors.background).toBe("#000000");
  });
});
