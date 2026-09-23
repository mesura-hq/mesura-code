import type { SidebarThreadSortOrder } from "@t3tools/contracts";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useRef } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { resolveMobileThreadSortOrder } from "../../state/thread-sort-order";

/**
 * Keeps the home list's thread order on the device.
 *
 * Upstream holds the order in component state seeded from a constant, so the
 * choice resets on every cold start. Mobile has no client settings sync, so this
 * fork stores it per device.
 *
 * It lives here rather than inside `home-list-options.ts` for a mechanical
 * reason worth stating, because the obvious tidier place does not work: that
 * module is imported by pure-function tests, and reaching the preference store
 * pulls `react-native` in with it, which the test runner cannot parse. Putting
 * these two effects there breaks `home-list-options.test.ts` and
 * `home-list-filter-menu.test.ts` at collection time.
 *
 * Safe to call from more than one screen. Both consumers share the same provider
 * state, hydration is per-instance and idempotent, and a save is skipped when
 * the stored value already matches.
 */
export function useThreadSortOrderPersistence(input: {
  readonly threadSortOrder: SidebarThreadSortOrder;
  readonly setThreadSortOrder: (value: SidebarThreadSortOrder) => void;
}): void {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const hydratedRef = useRef(false);
  const stored = AsyncResult.isSuccess(preferencesResult)
    ? resolveMobileThreadSortOrder(preferencesResult.value)
    : undefined;

  const { threadSortOrder, setThreadSortOrder } = input;

  // Hydrate at most once. Preferences resolve asynchronously, so a user who
  // changes the order before that must not have their choice overwritten by
  // whatever was on disk when the app launched.
  useEffect(() => {
    if (hydratedRef.current || stored === undefined) return;
    hydratedRef.current = true;
    if (stored !== threadSortOrder) setThreadSortOrder(stored);
  }, [stored, threadSortOrder, setThreadSortOrder]);

  // Write through once hydrated, so the picker's choice survives a restart.
  useEffect(() => {
    if (!hydratedRef.current || stored === undefined || stored === threadSortOrder) return;
    void savePreferences({ threadSortOrder });
  }, [stored, threadSortOrder, savePreferences]);
}
