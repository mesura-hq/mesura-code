import type * as monaco from "monaco-editor";
import { languages } from "monaco-editor/editor/editor.api.js";

/**
 * Astro as Monaco's HTML grammar plus `---` TypeScript frontmatter and `{ }` expressions, since
 * Monaco ships no Astro grammar. Expression contents stay plain text on purpose: they often hold
 * markup (`{items.map((item) => <li>{item}</li>)}`) a TypeScript tokenizer would colour wrongly.
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
    // Frontmatter is only ever the file's first block, so the fence is looked
    // for there and nowhere else: a `---` line in the markup is text.
    start: "astroStart",
    tokenizer: {
      ...html.tokenizer,
      astroStart: [
        [
          /^---\s*$/,
          { token: "delimiter", switchTo: "@frontmatter", nextEmbedded: "text/typescript" },
        ],
        [/(?=.)/, { token: "", switchTo: "@root" }],
      ],
      root: [
        [/[{}]/, "delimiter.bracket"],
        // HTML's own text rule would swallow the braces, so this one comes
        // first and stops at them.
        [/[^<{}]+/, ""],
        ...htmlRoot,
      ],
      // Only the closing fence: while TypeScript is embedded, Monarch reads
      // this state for nothing but where the embedding ends.
      frontmatter: [[/^---\s*$/, { token: "delimiter", switchTo: "@root", nextEmbedded: "@pop" }]],
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
