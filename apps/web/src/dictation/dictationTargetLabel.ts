import type { DictationTarget } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import { readThreadShell } from "~/state/entities";

/** The name a dictation target goes by in the widget: its thread's title. */
export function dictationTargetLabel(target: Exclude<DictationTarget, null> | null): string | null {
  if (target === null) return null;
  if (target.kind === "draft") return "New thread";
  return readThreadShell(scopeThreadRef(target.environmentId, target.threadId))?.title ?? null;
}
