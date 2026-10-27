import * as monaco from "monaco-editor";

import { MonacoFileModelCache, type MonacoFileModels } from "./monacoFileModels";

/**
 * The cache backed by real Monaco models, kept apart so `monacoFileModels.ts` and its eviction
 * tests never import the editor. The cache key is the model's URI.
 */
export function createMonacoFileModels(): MonacoFileModels {
  return new MonacoFileModelCache({
    create: (key, contents, languageId) =>
      monaco.editor.createModel(contents, languageId, monaco.Uri.parse(key)),
  });
}
