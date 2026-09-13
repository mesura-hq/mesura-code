// The `?worker` recipe, resolved through the package exports map. The path must
// not contain `esm/vs/`: that is the on-disk layout, while the exports map is
// what Vite resolves against. It is a deep import on purpose — the bare
// specifier is aliased to the curated entry, and a pattern that caught this one
// too would leave the editor with no worker at all.
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
 * Nothing to switch off any more, and that is the point.
 *
 * This used to pair each of the four bundled language services with an
 * all-false configuration — nine lines, every one of which had to be right,
 * and none of which stopped the workers being built. The services reference
 * their workers through Vite's worker plugin, so the chunks were emitted
 * whether or not anything ever asked for them: 9,160,971 bytes raw and
 * 2,058,703 gzipped, measured last cycle, shipped and never fetched.
 *
 * The app now imports a curated Monaco entry that never loads the services at
 * all, so there is nothing to configure and nothing to emit. Code intelligence
 * comes from a language server on the backend; a second analysis in the browser
 * would be a disagreeing answer.
 *
 * Syntax colouring is untouched: that is the Monarch grammars, which the
 * curated entry keeps, and they were never the expensive part.
 *
 * The function stays because importing this module for its side effect alone
 * is the kind of import a bundler is entitled to drop, and because callers
 * reading it can see where the environment is established.
 */
export function ensureMonacoEnvironment(): void {}
