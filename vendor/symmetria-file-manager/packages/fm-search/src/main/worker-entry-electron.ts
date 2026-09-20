/**
 * The Electron entry for a worker process.
 *
 * A utility process is handed a `parentPort` rather than `process.send`, which
 * is the only difference from the Node entry beside it. Both are thin on
 * purpose: `worker.ts` holds the logic and stays importable by a test, because
 * a module that starts serving at import time can only be observed, never
 * exercised.
 *
 * The directory arrives as `argv[2]`, as it does for the Node entry.
 */
import { serve, type WorkerMessage, type WorkerRequest, type WorkerTransport } from "./worker.ts";

/** Electron gives a utility process this; the types live in `electron`. */
declare const process: NodeJS.Process & {
  parentPort: {
    postMessage(message: unknown): void;
    on(event: "message", listener: (event: { data: unknown }) => void): void;
  };
};

function utilityTransport(): WorkerTransport {
  return {
    send: (message: WorkerMessage) => process.parentPort.postMessage(message),
    onMessage: (handler) => {
      // SAFETY: `parentPort` carries messages from the one process that spawned
      // this utility process, and that parent posts nothing but a
      // `WorkerRequest`. `serve` rejects an unrecognised request anyway.
      process.parentPort.on("message", (event) => handler(event.data as WorkerRequest));
    },
    close: () => process.exit(0),
  };
}

const directory = process.argv[2];
if (directory === undefined) {
  process.stderr.write("searchWorker: no directory given\n");
  process.exit(78);
}
await serve(directory, utilityTransport());
