import { DEFAULT_SIDEBAR_THREAD_SORT_ORDER, type SidebarThreadSortOrder } from "@t3tools/contracts";

import type { Preferences } from "../persistence/mobile-preferences";

/**
 * Resolves the thread sort order a device has chosen.
 *
 * Upstream keeps this order in component state, so it resets to the default on
 * every cold start. This fork stores it per device — mobile has no client
 * settings sync, so there is nowhere else for it to live — and this is the one
 * place that decides what a stored value means.
 *
 * A pure function rather than logic inside the provider, because the provider is
 * a React hook with no test renderer available here, and because a stored value
 * arrives from disk and cannot be trusted to be one of the two valid orders.
 */
export function resolveMobileThreadSortOrder(
  preferences: Preferences | undefined,
): SidebarThreadSortOrder {
  const stored = preferences?.threadSortOrder;
  return stored === "updated_at" || stored === "created_at"
    ? stored
    : DEFAULT_SIDEBAR_THREAD_SORT_ORDER;
}
