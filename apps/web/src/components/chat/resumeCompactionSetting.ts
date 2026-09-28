import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import type { ServerSettings } from "@t3tools/contracts/settings";

const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");

function readOfferResumeCompaction(config: unknown): boolean | undefined {
  if (config === null || typeof config !== "object") return undefined;
  const value = (config as Record<string, unknown>).offerResumeCompaction;
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Whether a Claude instance's `offerResumeCompaction` switch is on, which is
 * the schema default. Reads the instance's own config first. The default
 * instance falls back to the legacy `providers.claudeAgent` bucket until the
 * Settings UI promotes it into `providerInstances` on its first edit.
 */
export function isResumeCompactionOffered(
  settings: Pick<ServerSettings, "providerInstances" | "providers">,
  instanceId: ProviderInstanceId | null,
): boolean {
  const defaultInstanceId = defaultInstanceIdForDriver(CLAUDE_DRIVER_KIND);
  const resolvedInstanceId = instanceId ?? defaultInstanceId;
  const explicitInstance = Object.hasOwn(settings.providerInstances, resolvedInstanceId)
    ? settings.providerInstances[resolvedInstanceId]
    : undefined;
  if (explicitInstance) {
    return readOfferResumeCompaction(explicitInstance.config) ?? true;
  }
  if (resolvedInstanceId !== defaultInstanceId) return true;
  return settings.providers.claudeAgent.offerResumeCompaction;
}
