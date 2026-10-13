import { UsageProviderKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

const STORAGE_KEY = "t3code:usage-page-preferences:v1";
const UsagePagePreferencesSchema = Schema.Struct({
  metric: Schema.Literals(["cost", "tokens", "limits"]),
  windowDays: Schema.Literals([1, 7, 30, 90]),
  /** Providers filtered out of the page. Stored as hidden so new providers show by default. */
  hiddenProviders: Schema.optional(Schema.Array(UsageProviderKind)),
});
export type UsagePagePreferences = typeof UsagePagePreferencesSchema.Type;

// Mesura: the page has no Limits tab (the sidebar account-limits panel is the
// limits view), so Cost is the first-visit default and a saved "limits" reads as Cost.
const DEFAULT_PREFERENCES: UsagePagePreferences = { metric: "cost", windowDays: 30 };

export function readUsagePagePreferences(): UsagePagePreferences {
  try {
    const stored = getLocalStorageItem(STORAGE_KEY, UsagePagePreferencesSchema);
    if (!stored) return DEFAULT_PREFERENCES;
    return stored.metric === "limits" ? { ...stored, metric: "cost" } : stored;
  } catch (error) {
    console.error("Could not read Usage page preferences.", error);
    return DEFAULT_PREFERENCES;
  }
}

export function saveUsagePagePreferences(preferences: UsagePagePreferences): void {
  try {
    setLocalStorageItem(STORAGE_KEY, preferences, UsagePagePreferencesSchema);
  } catch (error) {
    console.error("Could not save Usage page preferences.", error);
  }
}
