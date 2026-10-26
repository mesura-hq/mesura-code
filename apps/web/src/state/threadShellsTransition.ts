import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { useAtomValueInTransition } from "./atomTransition";
import { throttledThreadShellsAtom } from "./throttledShells";

// Mesura: every thread shell, for views that list them all (sidebar, Symmetria feed). Rendering
// each streamed shell update synchronously inside the WebSocket message task held editor keys
// behind it, so this reads `throttledThreadShellsAtom` as a transition.
export function useThreadShellsInTransition(): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValueInTransition(throttledThreadShellsAtom);
}
