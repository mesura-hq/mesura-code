/**
 * The one Monaco worker this app runs: word-based operations and link detection, no language,
 * about 100 KB. Every other worker belongs to a language service, which this app leaves out
 * because code intelligence comes from the backend language server.
 */
export const EDITOR_WORKER_LABEL = "editorWorkerService";

export interface MonacoWorkerFactories {
  readonly editorWorker: () => Worker;
  readonly inertWorker: () => Worker;
}

/**
 * Chooses a worker for a label Monaco asks about. A guard: no language mode asks for a worker
 * today, so this catches a future Monaco feature this app did not know to disable.
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
