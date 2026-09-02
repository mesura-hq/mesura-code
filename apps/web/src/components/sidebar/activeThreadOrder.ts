import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import type { ThreadSortInput } from "@t3tools/client-runtime/state/thread-sort";
import { sortThreads } from "@t3tools/client-runtime/state/thread-sort";

import { sortThreadsForSidebar } from "../Sidebar.logic";

/**
 * Orders the active thread list, honouring the sidebar's thread sort setting.
 *
 * `#33` ordered this list by recent messages. Upstream's v2 sidebar replaced
 * that with `sortThreadsForSidebar`, a static creation anchor whose comment
 * states that activity never reorders the list — deliberate on their side, so
 * a row cannot move while it is being read. That removed the fork's behaviour.
 *
 * The setting that chooses between them already exists and upstream still reads
 * it in the command palette and the legacy sidebar; only the v2 sidebar stopped.
 * So this restores the fork's ordering under "Last user message" and leaves
 * upstream's anchor untouched under "Created at", rather than picking one.
 *
 * It lives in this fork-owned file and not in `Sidebar.logic.ts` on purpose.
 * That file takes about thirty upstream commits a quarter and `Sidebar.tsx`
 * about eighty, so the choice was between editing two hot upstream files or
 * one. Only the call site in `Sidebar.tsx` changes.
 */
export function sortActiveThreadsForSidebar<
  T extends {
    readonly id: string;
    readonly unsettledAt?: string | null | undefined;
  } & ThreadSortInput,
>(threads: readonly T[], sortOrder: SidebarThreadSortOrder): T[] {
  // "Last user message" is the fork's ordering: a thread rises when you use it.
  // Anything else keeps upstream's anchor, including its un-settle re-anchor,
  // so "Created at" behaves exactly as upstream's sidebar does today.
  return sortOrder === "updated_at"
    ? sortThreads(threads, sortOrder)
    : sortThreadsForSidebar(threads);
}
