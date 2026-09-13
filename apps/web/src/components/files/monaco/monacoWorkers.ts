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
