// The top-level language namespaces. `monaco.languages.typescript` and its
// siblings still exist in 0.56 but are deprecated stubs typed `{ deprecated:
// true }`, and the defaults moved here.
import { css, html, json, typescript } from "monaco-editor";
// The `?worker` recipe, resolved through the package exports map. The path must
// not contain `esm/vs/`: that is the on-disk layout, while the exports map is
// what Vite resolves against.
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";

import {
  ALL_CSS_FEATURES_OFF,
  ALL_HTML_FEATURES_OFF,
  ALL_JSON_FEATURES_OFF,
  ALL_TYPESCRIPT_FEATURES_OFF,
  createInertWorker,
  workerForLabel,
} from "./monacoWorkers";

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

// Not a correctness guard: setting the same static configuration twice is
// harmless. It just saves nine calls when several surfaces mount.
let applied = false;

/**
 * Switches every bundled language service off, once.
 *
 * Code intelligence in this app comes from a language server on the backend.
 * Monaco's own analysis would be a second, disagreeing answer, and it is the
 * largest thing in the bundle. With no feature registered, a language mode
 * never starts its worker, so this is the mechanism and the `getWorker` above
 * is only the guard.
 *
 * Syntax colouring is untouched: that comes from the Monarch grammars, which
 * are registered separately from the language services.
 */
export function ensureMonacoEnvironment(): void {
  if (applied) return;
  applied = true;

  typescript.typescriptDefaults.setModeConfiguration(ALL_TYPESCRIPT_FEATURES_OFF);
  typescript.javascriptDefaults.setModeConfiguration(ALL_TYPESCRIPT_FEATURES_OFF);
  json.jsonDefaults.setModeConfiguration(ALL_JSON_FEATURES_OFF);
  css.cssDefaults.setModeConfiguration(ALL_CSS_FEATURES_OFF);
  css.lessDefaults.setModeConfiguration(ALL_CSS_FEATURES_OFF);
  css.scssDefaults.setModeConfiguration(ALL_CSS_FEATURES_OFF);
  html.htmlDefaults.setModeConfiguration(ALL_HTML_FEATURES_OFF);
  html.handlebarDefaults.setModeConfiguration(ALL_HTML_FEATURES_OFF);
  html.razorDefaults.setModeConfiguration(ALL_HTML_FEATURES_OFF);
}
