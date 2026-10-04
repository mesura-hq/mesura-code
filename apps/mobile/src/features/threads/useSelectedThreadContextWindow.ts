import type { ThreadId } from "@t3tools/contracts";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/context-window";
import { useMemo } from "react";

import { useSelectedThreadDetail } from "../../state/use-thread-detail";
import { selectThreadContextWindowSnapshot } from "./contextWindowIndicatorState";

/**
 * The latest context-window snapshot of the composer's thread, read from the
 * selected thread's detail subscription so no screen has to thread it through
 * props. Recomputed only when the activities array or the thread changes.
 */
export function useSelectedThreadContextWindow(threadId: ThreadId): ContextWindowSnapshot | null {
  const detail = useSelectedThreadDetail();
  const detailThreadId = detail?.id ?? null;
  const activities = detail?.activities;
  return useMemo(
    () =>
      selectThreadContextWindowSnapshot({
        detail: detailThreadId !== null && activities ? { id: detailThreadId, activities } : null,
        threadId,
      }),
    [activities, detailThreadId, threadId],
  );
}
