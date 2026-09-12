// The top-level language namespaces. `monaco.languages.typescript` and its
// siblings still exist in 0.56 but are deprecated stubs typed `{ deprecated:
// true }`; these are where the real defaults live now.
import type { css, html, json, typescript } from "monaco-editor";

/**
 * The one Monaco worker this app runs.
 *
 * It serves word-based operations and link detection, knows no language, and is
 * about a hundred kilobytes. Every other worker Monaco can start belongs to a
 * bundled language service, and those are exactly what this app does not want:
 * code intelligence comes from a language server on the backend, so a second
 * analysis running in the browser would ship the largest part of the bundle to
 * disagree with the first one.
 */
export const EDITOR_WORKER_LABEL = "editorWorkerService";

export interface MonacoWorkerFactories {
  readonly editorWorker: () => Worker;
  readonly inertWorker: () => Worker;
}

/**
 * Chooses a worker for a label Monaco asks about.
 *
 * A guard rather than the mechanism: with every language feature switched off
 * below, the language modes never ask for a worker at all. This is what catches
 * it if one ever does — a new Monaco version registering a feature this app did
 * not know to disable, for instance.
 */
export function workerForLabel(label: string, factories: MonacoWorkerFactories): Worker {
  return label === EDITOR_WORKER_LABEL ? factories.editorWorker() : factories.inertWorker();
}

/** A worker that answers nothing, for a language service that should not run. */
export function createInertWorker(): Worker {
  const url = URL.createObjectURL(new Blob(["self.onmessage=()=>{}"], { type: "text/javascript" }));
  const worker = new Worker(url);
  // The browser has resolved the blob by the time the constructor returns, so
  // revoking now frees it rather than leaking one object URL per call.
  URL.revokeObjectURL(url);
  return worker;
}

/**
 * Every key of `T`, required, and every one of them `false`.
 *
 * The requiring is the point. `ModeConfiguration`'s own fields are all optional,
 * so an object literal that simply omits a feature type-checks happily — which
 * means a Monaco upgrade adding a feature would quietly leave it enabled. Under
 * this type the same omission is a compile error.
 */
type AllFeaturesOff<T> = { readonly [K in keyof Required<T>]: false };

// Every feature of every bundled language service, off. The key sets differ per
// family and are spelled out rather than generated, so that a Monaco upgrade
// adding a feature breaks the build here instead of silently switching a
// language service back on.

export const ALL_TYPESCRIPT_FEATURES_OFF: AllFeaturesOff<typescript.ModeConfiguration> = {
  completionItems: false,
  hovers: false,
  documentSymbols: false,
  definitions: false,
  references: false,
  documentHighlights: false,
  rename: false,
  diagnostics: false,
  documentRangeFormattingEdits: false,
  signatureHelp: false,
  onTypeFormattingEdits: false,
  codeActions: false,
  inlayHints: false,
};

export const ALL_JSON_FEATURES_OFF: AllFeaturesOff<json.ModeConfiguration> = {
  documentFormattingEdits: false,
  documentRangeFormattingEdits: false,
  completionItems: false,
  hovers: false,
  documentSymbols: false,
  // Semantic tokens from the JSON service. Syntax colouring comes from the
  // Monarch grammar, which is a separate registration and stays on.
  tokens: false,
  colors: false,
  foldingRanges: false,
  diagnostics: false,
  selectionRanges: false,
};

export const ALL_CSS_FEATURES_OFF: AllFeaturesOff<css.ModeConfiguration> = {
  completionItems: false,
  hovers: false,
  documentSymbols: false,
  definitions: false,
  references: false,
  documentHighlights: false,
  rename: false,
  colors: false,
  foldingRanges: false,
  diagnostics: false,
  selectionRanges: false,
  documentFormattingEdits: false,
  documentRangeFormattingEdits: false,
};

export const ALL_HTML_FEATURES_OFF: AllFeaturesOff<html.ModeConfiguration> = {
  completionItems: false,
  hovers: false,
  documentSymbols: false,
  links: false,
  documentHighlights: false,
  rename: false,
  colors: false,
  foldingRanges: false,
  diagnostics: false,
  selectionRanges: false,
  documentFormattingEdits: false,
  documentRangeFormattingEdits: false,
};
