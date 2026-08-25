import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { stackedThreadToast, toastManager } from "../components/ui/toast";

/**
 * Reports a failed thread action, and stays quiet on an interruption — a
 * command the user cancelled is not an error to announce.
 *
 * Upstream has its own copies of this body in `useThreadActionMenu.ts` and
 * `Sidebar.tsx`. They are deliberately left alone: lifting them out would put a
 * conflict in two weekly-rewritten files for four lines. This copy lives in a
 * file of ours so the next caller can import it instead of writing a fifth.
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
