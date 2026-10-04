import type { DictationTarget } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import { readThread } from "~/state/entities";

/** The name a dictation target goes by in the widget: its thread's title. */
export function dictationTargetLabel(target: Exclude<DictationTarget, null> | null): string | null {
  if (target === null) return null;
  if (target.kind === "draft") return "New thread";
  return readThread(scopeThreadRef(target.environmentId, target.threadId))?.title ?? null;
}
