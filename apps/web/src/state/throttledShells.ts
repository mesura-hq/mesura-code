import type { ScopedProjectRef } from "@t3tools/contracts";
import {
  parseProjectRefCollectionKey,
  projectRefCollectionKey,
} from "@t3tools/client-runtime/state/entities";
import { Atom } from "effect/reactivity";

import { SHELL_VIEW_INTERVAL_MS, throttledAtom } from "./throttledAtom";
import { environmentThreadShells } from "./threads";

/** Every thread shell, re-read at most once per `SHELL_VIEW_INTERVAL_MS`. */
export const throttledThreadShellsAtom = throttledAtom(
  environmentThreadShells.threadShellsAtom,
  SHELL_VIEW_INTERVAL_MS,
).pipe(Atom.withLabel("web-throttled-thread-shells"));

const throttledProjectThreadsFamily = Atom.family((key: string) =>
  throttledAtom(
    environmentThreadShells.threadShellsForProjectRefsAtom(parseProjectRefCollectionKey(key)),
    SHELL_VIEW_INTERVAL_MS,
  ),
);

export function throttledThreadShellsForProjectRefsAtom(refs: ReadonlyArray<ScopedProjectRef>) {
  return throttledProjectThreadsFamily(projectRefCollectionKey(refs));
}
