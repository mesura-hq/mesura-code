/**
 * The Monaco modules this app reaches into that ship no types.
 *
 * JSON is the only language the file panel colours whose grammar is not under
 * `languages/definitions`. Its tokenizer lives inside the language service, in
 * a module of its own, and taking that module without the service is what lets
 * the panel colour JSON while emitting no JSON worker. The service's public
 * entry has types; this internal one does not.
 *
 * Typed against Monaco's own `TokensProvider`, which is what the call site
 * needs it to be. The import is inside the declaration so this file stays an
 * ambient one rather than becoming a module of its own.
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
