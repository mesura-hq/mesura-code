import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { Atom } from "effect/reactivity";

import { environmentThreadShells } from "./threads";

/** The thread evidence the first-run decision reads (`firstRun.logic.ts`). */
export interface FirstRunThreadEvidence {
  /**
   * The threads, while there is at most one; past that, the list as it was
   * when it first grew past one. The decision reads only that there is more
   * than one, and the thread itself when there is exactly one.
   */
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly threadCount: number;
}

/**
 * Mesura: live, but changes only when the evidence the decision reads changes, so streamed
 * shell updates do not re-render the gate. Do not throttle it instead: a list behind the
 * live readiness flags can keep a wrong `wizard` decision.
 */
export function makeFirstRunThreadEvidenceAtom(
  source: Atom.Atom<ReadonlyArray<EnvironmentThreadShell>>,
): Atom.Atom<FirstRunThreadEvidence> {
  let previous: FirstRunThreadEvidence | null = null;
  return Atom.make((get) => {
    const threads = get(source);
    if (previous !== null) {
      const unchanged =
        threads.length > 1
          ? previous.threadCount > 1 && previous.threadCount === threads.length
          : previous.threadCount === threads.length && previous.threads[0] === threads[0];
      if (unchanged) return previous;
      if (threads.length > 1 && previous.threadCount > 1) {
        previous = { threads: previous.threads, threadCount: threads.length };
        return previous;
      }
    }
    previous = { threads, threadCount: threads.length };
    return previous;
  });
}

const firstRunThreadEvidenceAtom = makeFirstRunThreadEvidenceAtom(
  environmentThreadShells.threadShellsAtom,
).pipe(Atom.withLabel("web-first-run-thread-evidence"));

export function useFirstRunThreadEvidence(): FirstRunThreadEvidence {
  return useAtomValue(firstRunThreadEvidenceAtom);
}
