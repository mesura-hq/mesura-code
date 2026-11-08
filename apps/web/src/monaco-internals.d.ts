/**
 * The JSON tokenizer alone, without the language service, colours JSON while emitting no
 * JSON worker; this internal module ships no types. The import stays inside the
 * declaration so this file remains ambient rather than a module.
 */
declare module "monaco-editor/languages/features/json/tokenization.js" {
  export function createTokenizationSupport(
    supportComments: boolean,
  ): import("monaco-editor").languages.TokensProvider;
}

/**
 * The HTML grammar, which the Astro grammar in `monacoAstroLanguage.ts` builds
 * on. Monaco loads it itself through `register.js`; only the module the loader
 * points at is untyped.
 */
declare module "monaco-editor/languages/definitions/html/html.js" {
  export const conf: import("monaco-editor").languages.LanguageConfiguration;
  export const language: import("monaco-editor").languages.IMonarchLanguage;
}
