/** The shape of one entry from `monaco.languages.getLanguages()`. */
export interface MonacoLanguageEntry {
  readonly id: string;
  readonly extensions?: ReadonlyArray<string> | undefined;
  readonly filenames?: ReadonlyArray<string> | undefined;
}

export const PLAINTEXT_LANGUAGE_ID = "plaintext";

/**
 * Picks the language from the list Monaco actually registered, passed in so tests need no Monaco.
 * Exact filenames win (`Dockerfile`, `Makefile` have no extension), then the longest matching
 * extension, so `.d.ts` is not claimed by a language that registered only `.ts`.
 */
export function languageIdForPath(
  relativePath: string,
  languages: ReadonlyArray<MonacoLanguageEntry>,
): string {
  const fileName = relativePath.split("/").at(-1) ?? relativePath;

  for (const language of languages) {
    if (language.filenames?.includes(fileName) === true) return language.id;
  }

  const lowerName = fileName.toLowerCase();
  let bestId: string | null = null;
  let bestLength = 0;

  for (const language of languages) {
    for (const extension of language.extensions ?? []) {
      const lowerExtension = extension.toLowerCase();
      // A dotfile is a name, not an extension: `.gitignore` must not match by whole filename.
      // Accepted false negative: a file literally named `.ts` falls through to plaintext.
      if (lowerName === lowerExtension) continue;
      if (!lowerName.endsWith(lowerExtension)) continue;
      if (lowerExtension.length <= bestLength) continue;
      bestId = language.id;
      bestLength = lowerExtension.length;
    }
  }

  return bestId ?? PLAINTEXT_LANGUAGE_ID;
}
