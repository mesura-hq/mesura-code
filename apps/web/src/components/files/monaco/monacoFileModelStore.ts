import * as monaco from "monaco-editor";

import { MonacoFileModelCache, type MonacoFileModels } from "./monacoFileModels";

/**
 * The cache, backed by real Monaco models.
 *
 * Separate from `monacoFileModels.ts` so that module stays free of Monaco: the
 * eviction rules are what deserve testing, and importing the editor to test
 * them would pull two megabytes into a unit test to no purpose.
 *
 * The cache key is the model's URI, so nothing else is needed to build one.
 */
export function createMonacoFileModels(): MonacoFileModels {
  return new MonacoFileModelCache({
    create: (key, contents, languageId) =>
      monaco.editor.createModel(contents, languageId, monaco.Uri.parse(key)),
  });
}
