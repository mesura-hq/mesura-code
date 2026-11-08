import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import type { ThreadSortInput } from "@t3tools/client-runtime/state/thread-sort";
import { sortThreads } from "@t3tools/client-runtime/state/thread-sort";

import { sortThreadsForSidebar } from "../Sidebar.logic";

/**
 * Orders the active thread list by the sidebar's thread sort setting: "Last user message" keeps
 * the fork's recent-message order, "Created at" keeps upstream's static anchor
 * (`sortThreadsForSidebar`). Fork-owned on purpose: `Sidebar.logic.ts` and `Sidebar.tsx` are hot
 * upstream files.
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
