import type { SidebarThreadSortOrder } from "@t3tools/contracts";
import { DEFAULT_SIDEBAR_THREAD_SORT_ORDER } from "@t3tools/contracts";

import type { Preferences } from "../persistence/mobile-preferences";

export const THREAD_SORT_OPTIONS: ReadonlyArray<{
  readonly value: SidebarThreadSortOrder;
  readonly label: string;
}> = [
  { value: "updated_at", label: "Last user message" },
  { value: "created_at", label: "Created at" },
];

export function resolveMobileThreadSortOrder(
  preferences: Pick<Preferences, "threadSortOrder"> | null | undefined,
): SidebarThreadSortOrder {
  return preferences?.threadSortOrder ?? DEFAULT_SIDEBAR_THREAD_SORT_ORDER;
}
