// Deep import on purpose: the bare specifier is aliased to the curated entry, and an alias that
// also matched this path would leave the editor without a worker. The path must not contain
// `esm/vs/`, because Vite resolves against the exports map, not the on-disk layout.
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";

import { createInertWorker, workerForLabel } from "./monacoWorkers";

// Assigned at module scope rather than inside the function below, because
// Monaco reads this the first time anything asks for a worker, which can happen
// while an editor is still being constructed.
self.MonacoEnvironment = {
  getWorker: (_workerId: string, label: string) =>
    workerForLabel(label, {
      editorWorker: () => new EditorWorker(),
      inertWorker: createInertWorker,
    }),
};

/**
 * Nothing to switch off: the curated Monaco entry never loads the language services. The function
 * stays because a bundler may drop a side-effect-only import, and callers show where the
 * environment is established.
 */
export function ensureMonacoEnvironment(): void {}
