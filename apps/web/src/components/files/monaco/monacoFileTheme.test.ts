import { describe, expect, it } from "vite-plus/test";

import {
  defineMesuraMonacoThemes,
  MESURA_MONACO_DARK,
  MESURA_MONACO_LIGHT,
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
