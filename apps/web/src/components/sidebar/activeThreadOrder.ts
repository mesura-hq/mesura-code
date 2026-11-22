import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  resolveThreadActivityTimestamp,
  toSortableTimestamp,
} from "@t3tools/client-runtime/state/thread-sort";

import { sortThreadsForSidebar } from "../Sidebar.logic";

type ActivitySortInput = Pick<
  EnvironmentThreadShell,
  "latestUserMessageAt" | "latestRun" | "updatedAt"
>;

/**
 * Orders the active thread list by the sidebar's thread sort setting: "Last activity" sorts by
 * the time each row shows, "Created at" keeps upstream's static anchor (`sortThreadsForSidebar`).
 * Fork-owned on purpose: `Sidebar.logic.ts` and `Sidebar.tsx` are hot upstream files.
 */
export function sortActiveThreadsForSidebar<
  T extends {
    readonly id: string;
    readonly createdAt: string;
    readonly unsettledAt?: string | null | undefined;
  } & ActivitySortInput,
>(threads: readonly T[], sortOrder: SidebarThreadSortOrder): T[] {
  return sortOrder === "updated_at"
    ? sortThreadsByActivity(threads)
    : sortThreadsForSidebar(threads);
}

// The key must be the row's own time label (`resolveThreadActivityTimestamp`), so a finished
// thread rises when its turn ends and the list never reads out of order. Sorting by the last
// user-authored message while the row showed the last turn's end did exactly that.
function sortThreadsByActivity<T extends { readonly id: string } & ActivitySortInput>(
  threads: readonly T[],
): T[] {
  if (threads.length < 2) return [...threads];
  return threads
    .map((thread) => ({
      thread,
      timestamp:
        toSortableTimestamp(resolveThreadActivityTimestamp(thread) ?? undefined) ??
        Number.NEGATIVE_INFINITY,
    }))
    .sort(
      (left, right) =>
        right.timestamp - left.timestamp ||
        (left.thread.id < right.thread.id ? 1 : left.thread.id > right.thread.id ? -1 : 0),
    )
    .map(({ thread }) => thread);
}
