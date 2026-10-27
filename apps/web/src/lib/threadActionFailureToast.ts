import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { stackedThreadToast, toastManager } from "../components/ui/toast";

/**
 * Quiet on an interruption: a command the user cancelled is not an error to announce.
 * Upstream's copies in `useThreadActionMenu.ts` and `Sidebar.tsx` stay on purpose, since
 * lifting them out would conflict in two weekly-rewritten files. New callers import this.
 */
export function reportThreadActionFailure(
  title: string,
  result: AtomCommandResult<unknown, unknown>,
): void {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}
