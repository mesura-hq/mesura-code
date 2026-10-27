import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { ServerSettings } from "@t3tools/contracts/settings";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";

// Mesura: the Claude instance fields that only take effect while the
// environment's `idleCompactionEnabled` switch is on.
const IDLE_COMPACTION_INSTANCE_FIELDS: ReadonlySet<string> = new Set([
  "offerResumeCompaction",
  "idleCompaction",
]);

/**
 * The provider settings fields to hide, so none shows a value that is not in
 * effect. A server without the switch keeps using them, so they stay.
 */
export function hiddenIdleCompactionFields(
  settings: Pick<ServerSettings, "idleCompactionEnabled">,
  serverReadsSwitch: boolean,
): ReadonlySet<string> | undefined {
  return serverReadsSwitch && !settings.idleCompactionEnabled
    ? IDLE_COMPACTION_INSTANCE_FIELDS
    : undefined;
}

export function useHiddenIdleCompactionFields(
  environmentId: EnvironmentId,
): ReadonlySet<string> | undefined {
  const enabled = useEnvironmentSettings(
    environmentId,
    (settings) => settings.idleCompactionEnabled,
  );
  const serverReadsSwitch = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.environment.capabilities.idleCompactionSwitch === true,
  );
  return hiddenIdleCompactionFields({ idleCompactionEnabled: enabled }, serverReadsSwitch);
}
