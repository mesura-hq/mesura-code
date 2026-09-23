// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";

const SOURCE = [
  "---",
  "import BaseLayout from '../layouts/BaseLayout.astro';",
  "---",
  '<BaseLayout title="Hi">',
  "  <p>{count} items</p>",
  "</BaseLayout>",
].join("\n");

/** Each line's token types, after the lazily loaded grammars have arrived. */
async function tokenTypes(source = SOURCE): Promise<string[][]> {
  const monaco = await import("monaco-editor/editor/editor.api.js");
  await import("monaco-editor/languages/definitions/html/register.js");
  await import("monaco-editor/languages/definitions/typescript/register.js");
  await import("./monacoAstroLanguage.ts");
  // `colorize` waits for a language's tokenizer to load; `tokenize` does not,
  // and answers with no tokens at all until it has.
  await monaco.editor.colorize(source, "astro", {});
  await monaco.editor.colorize(source, "typescript", {});
  return monaco.editor.tokenize(source, "astro").map((line) => line.map((token) => token.type));
}

describe("the Astro grammar", () => {
  it("colours the frontmatter as TypeScript and the markup as HTML", async () => {
    const lines = await tokenTypes();
    expect(lines[1]).toContain("keyword.ts");
    expect(lines[1]).toContain("string.ts");
    expect(lines[3]).toContain("tag.astro");
    expect(lines[3]).toContain("attribute.value.astro");
    expect(lines[4]).toContain("delimiter.bracket.astro");
    expect(lines[5]).toContain("tag.astro");
  });

  it("reads a `---` line in the markup as text, not as frontmatter", async () => {
    const lines = await tokenTypes(["<p>one</p>", "---", "<p>const two = 2;</p>"].join("\n"));
    expect(lines[2]).toContain("tag.astro");
    expect(lines[2]).not.toContain("keyword.ts");
  });
});
