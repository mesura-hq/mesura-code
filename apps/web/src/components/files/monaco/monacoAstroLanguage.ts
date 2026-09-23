import type * as monaco from "monaco-editor";
import { languages } from "monaco-editor/editor/editor.api.js";

/**
 * Astro, coloured as the HTML it mostly is.
 *
 * Monaco ships no Astro grammar, and with modal editing on Neovim's own
 * highlighter is stopped, so an `.astro` file had no colour at all. An Astro
 * component is HTML with two additions that matter for colour: a `---` fenced
 * frontmatter block of TypeScript at the top, and `{ }` expressions in the
 * markup. This takes Monaco's HTML grammar whole and adds those two.
 *
 * Deliberately approximate: an expression's contents stay as plain text rather
 * than being parsed as TypeScript, because they routinely hold markup of their
 * own (`{items.map((item) => <li>{item}</li>)}`) that a TypeScript tokenizer
 * would colour as operators.
 */
export function astroMonarchLanguage(
  html: monaco.languages.IMonarchLanguage,
): monaco.languages.IMonarchLanguage {
  const htmlRoot = html.tokenizer["root"] ?? [];
  return {
    ...html,
    tokenPostfix: ".astro",
    // Component names are capitalised (`<BaseLayout>`) and HTML ignores case,
    // which is harmless here: the tag rules already accept either.
    tokenizer: {
      ...html.tokenizer,
      root: [
        [/^---\s*$/, { token: "delimiter", next: "@frontmatter", nextEmbedded: "text/typescript" }],
        [/[{}]/, "delimiter.bracket"],
        // HTML's own text rule would swallow the braces, so this one comes
        // first and stops at them.
        [/[^<{}]+/, ""],
        ...htmlRoot,
      ],
      frontmatter: [
        [/^---\s*$/, { token: "delimiter", next: "@pop", nextEmbedded: "@pop" }],
        [/[^-]+|-/, ""],
      ],
    },
  };
}

languages.register({ id: "astro", extensions: [".astro"], aliases: ["Astro", "astro"] });

const loadHtml = () => import("monaco-editor/languages/definitions/html/html.js");

languages.registerTokensProviderFactory("astro", {
  create: async () => astroMonarchLanguage((await loadHtml()).language),
});
languages.onLanguageEncountered("astro", async () => {
  languages.setLanguageConfiguration("astro", (await loadHtml()).conf);
});
