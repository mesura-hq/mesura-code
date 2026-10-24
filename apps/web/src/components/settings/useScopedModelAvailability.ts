import type { ProviderInstanceId, UnifiedSettings } from "@t3tools/contracts";
import { useCallback } from "react";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { useSettingsScope } from "./SettingsScopeContext";

/**
 * A model choice fans out to every selected target, so it must exist on all
 * of them. Returns the reason a (instance, model) pair cannot be applied, or
 * null when every target can honor it. The representative's entries decide
 * which driver the instance id names. With `requireTextGeneration`, each
 * target's providers are filtered the way the representative's text
 * generation catalog is, so a provider that cannot generate text on one
 * target is unavailable there.
 */
export function useScopedModelDisabledReason(
  settings: UnifiedSettings,
  entries: readonly ProviderInstanceEntry[],
  options: { requireTextGeneration?: boolean } = {},
) {
  const requireTextGeneration = options.requireTextGeneration === true;
  const { targets } = useSettingsScope();
  const { environments } = useEnvironments();
  return useCallback(
    (instanceId: ProviderInstanceId, model: string): string | null => {
      const sourceEntry = entries.find((entry) => entry.instanceId === instanceId);
      for (const candidate of targets) {
        const environment = environments.find(
          (entry) => entry.environmentId === candidate.environmentId,
        );
        const config = environment?.serverConfig;
        if (!config) continue;
        const providers = requireTextGeneration
          ? config.providers.filter((provider) => provider.supportsTextGeneration !== false)
          : config.providers;
        const entry = applyProviderInstanceSettings(
          deriveProviderInstanceEntries(providers),
          candidate.settings,
        ).find((option) => option.instanceId === instanceId);
        const options = getCustomModelOptionsByInstance(
          { ...settings, ...candidate.settings },
          providers,
        ).get(instanceId);
        if (
          !entry?.enabled ||
          !entry.isAvailable ||
          entry.driverKind !== sourceEntry?.driverKind ||
          !options?.some((option) => option.slug === model && !option.isUnavailable)
        ) {
          return `This model is unavailable on ${environment?.label ?? "a selected environment"}. Select that environment to choose its model separately.`;
        }
      }
      return null;
    },
    [entries, environments, requireTextGeneration, settings, targets],
  );
}
