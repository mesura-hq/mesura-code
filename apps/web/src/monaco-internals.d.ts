/**
 * The one Monaco module this app reaches into that ships no types.
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
