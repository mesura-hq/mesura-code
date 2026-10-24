import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { useAtomValueInTransition } from "./atomTransition";
import { throttledThreadShellsAtom } from "./throttledShells";

// Mesura: every thread shell, for the views that list them all (the sidebar,
// the Symmetria feed). A streamed shell update re-rendered each of them
// synchronously inside the WebSocket message task, which held editor keys
// behind it; ten streaming agents send about four per second (phase 6 of the
// editor latency cycle). Published by `throttledThreadShellsAtom`, rendered as
// a transition.
export function useThreadShellsInTransition(): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValueInTransition(throttledThreadShellsAtom);
}
