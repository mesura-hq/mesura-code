import type { EnvironmentId } from "@t3tools/contracts";
import type { ServerSettings } from "@t3tools/contracts/settings";

import { useEnvironmentSettings } from "../../hooks/useSettings";

// Mesura: the Claude instance fields that only take effect while the
// environment's `idleCompactionEnabled` switch is on.
const IDLE_COMPACTION_INSTANCE_FIELDS: ReadonlySet<string> = new Set([
  "offerResumeCompaction",
  "idleCompaction",
]);

/** The provider settings fields to hide, so none shows a value that is not in effect. */
export function hiddenIdleCompactionFields(
  settings: Pick<ServerSettings, "idleCompactionEnabled">,
): ReadonlySet<string> | undefined {
  return settings.idleCompactionEnabled ? undefined : IDLE_COMPACTION_INSTANCE_FIELDS;
}

export function useHiddenIdleCompactionFields(
  environmentId: EnvironmentId,
): ReadonlySet<string> | undefined {
  return useEnvironmentSettings(environmentId, hiddenIdleCompactionFields);
}
