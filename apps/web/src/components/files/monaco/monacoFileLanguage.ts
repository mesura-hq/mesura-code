/** The shape of one entry from `monaco.languages.getLanguages()`. */
export interface MonacoLanguageEntry {
  readonly id: string;
  readonly extensions?: ReadonlyArray<string> | undefined;
  readonly filenames?: ReadonlyArray<string> | undefined;
}

export const PLAINTEXT_LANGUAGE_ID = "plaintext";

/**
 * Picks the language for a file, from the list Monaco actually registered.
 *
 * Taking the list as an argument rather than reading it from Monaco keeps this
 * testable without pulling two thousand modules into a unit test, and keeps the
 * answer honest: a language that was not registered cannot be returned.
 *
 * Exact filenames win, because the files that rely on them have no extension at
 * all (`Dockerfile`, `Makefile`). Then the longest matching extension, so a file
 * ending `.d.ts` cannot be claimed by a language that only registered `.ts`
 * when one registered the longer form.
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
      // A dotfile is a name, not an extension: `.gitignore` must not match a
      // language that registered `.gitignore` as an extension by matching the
      // whole filename. Accepted false negative: a file literally named `.ts`
      // falls through to plaintext. No language in 0.56 registers a bare
      // dotfile-shaped extension, so this is defensive rather than load-bearing.
      if (lowerName === lowerExtension) continue;
      if (!lowerName.endsWith(lowerExtension)) continue;
      if (lowerExtension.length <= bestLength) continue;
      bestId = language.id;
      bestLength = lowerExtension.length;
    }
  }

  return bestId ?? PLAINTEXT_LANGUAGE_ID;
}
