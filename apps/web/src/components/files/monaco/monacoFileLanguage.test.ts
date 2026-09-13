import { describe, expect, it } from "vite-plus/test";

import { languageIdForPath } from "./monacoFileLanguage";

// Shaped like what `monaco.languages.getLanguages()` returns, kept small so the
// test says what it depends on instead of importing two thousand modules.
const LANGUAGES = [
  { id: "typescript", extensions: [".ts", ".tsx"] },
  { id: "javascript", extensions: [".js", ".mjs"] },
  { id: "json", extensions: [".json"], filenames: ["tsconfig.json"] },
  { id: "dockerfile", extensions: [".dockerfile"], filenames: ["Dockerfile"] },
  { id: "shell", extensions: [".sh"] },
  { id: "markdown", extensions: [".md"] },
  { id: "yaml", extensions: [".yml", ".yaml"] },
  { id: "vue", extensions: [".vue"] },
  { id: "handlebars", extensions: [".hbs", ".handlebars"] },
];

describe("languageIdForPath", () => {
  it("matches by extension", () => {
    expect(languageIdForPath("src/index.ts", LANGUAGES)).toBe("typescript");
    expect(languageIdForPath("scripts/build.mjs", LANGUAGES)).toBe("javascript");
  });

  it("prefers an exact filename over an extension", () => {
    // `Dockerfile` has no extension at all, and `tsconfig.json` would otherwise
    // match plain json — which is right here, but the rule has to be filename first.
    expect(languageIdForPath("Dockerfile", LANGUAGES)).toBe("dockerfile");
    expect(languageIdForPath("deploy/Dockerfile", LANGUAGES)).toBe("dockerfile");
  });

  it("matches the longest extension when several could apply", () => {
    // `.handlebars` and `.hbs` both belong to one language here, but the rule
    // matters where a shorter suffix of a longer extension belongs elsewhere.
    expect(languageIdForPath("views/page.handlebars", LANGUAGES)).toBe("handlebars");
  });

  it("is case insensitive on the extension", () => {
    expect(languageIdForPath("README.MD", LANGUAGES)).toBe("markdown");
  });

  it("falls back to plaintext for an unknown extension", () => {
    expect(languageIdForPath("notes.wat", LANGUAGES)).toBe("plaintext");
  });

  it("falls back to plaintext for a file with no extension", () => {
    expect(languageIdForPath("LICENSE", LANGUAGES)).toBe("plaintext");
  });

  it("ignores a leading dot in a dotfile name", () => {
    // `.gitignore` is not an extension called `gitignore`.
    expect(languageIdForPath(".gitignore", LANGUAGES)).toBe("plaintext");
  });

  it("tolerates a language entry with neither extensions nor filenames", () => {
    expect(languageIdForPath("a.ts", [{ id: "mystery" }, ...LANGUAGES])).toBe("typescript");
  });
});
