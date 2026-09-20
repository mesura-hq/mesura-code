/**
 * The Node-fork entry for a worker process.
 *
 * Kept apart from `worker.ts` so that module stays importable by a test
 * without spawning anything: a module that starts serving at import time
 * cannot be unit-tested, only observed.
 *
 * The directory arrives as `argv[2]`.
 */
import { nodeChildTransport, serve } from "./worker.ts";

const directory = process.argv[2];
if (directory === undefined) {
  process.stderr.write("worker-entry: no directory given\n");
  process.exit(78);
}
await serve(directory, nodeChildTransport());
