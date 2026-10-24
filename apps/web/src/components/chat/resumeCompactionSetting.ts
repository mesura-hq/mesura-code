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
 * the schema default. Reads the instance's own config; an instance without
 * one (the default instance before its first edit) keeps the default. The
 * legacy `providers.claudeAgent` bucket is gone upstream, so it is not read.
 */
export function isResumeCompactionOffered(
  settings: Pick<ServerSettings, "providerInstances">,
  instanceId: ProviderInstanceId | null,
): boolean {
  const resolvedInstanceId = instanceId ?? defaultInstanceIdForDriver(CLAUDE_DRIVER_KIND);
  const explicitInstance = Object.hasOwn(settings.providerInstances, resolvedInstanceId)
    ? settings.providerInstances[resolvedInstanceId]
    : undefined;
  if (!explicitInstance || explicitInstance.driver !== CLAUDE_DRIVER_KIND) return true;
  return readOfferResumeCompaction(explicitInstance.config) ?? true;
}
