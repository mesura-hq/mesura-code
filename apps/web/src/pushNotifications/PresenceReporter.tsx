import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useContext, useEffect } from "react";

import { useServerConfigs } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { openPresenceReport, pushSettingsPermissionAtom } from "../state/pushNotifications";
import { type PresenceHub, useReportPresence } from "./useReportPresence";

/**
 * Mesura: tells every connected host that takes presence reports whether the
 * developer is at this client, so each holds its phone pushes while they work
 * here. Not only the primary environment: the desktop's primary is its own
 * local server, while the host that pushes to the phone is a remote one.
 */
export function PresenceReporter() {
  const hub = useReportPresence();
  const { environments } = useEnvironments();
  const serverConfigs = useServerConfigs();
  return environments
    .filter(
      ({ environmentId, connection }) =>
        connection.phase === "connected" &&
        serverConfigs.get(environmentId)?.environment.capabilities.pushPresence === true,
    )
    .map(({ environmentId }) => (
      <PresenceDestination key={environmentId} hub={hub} environmentId={environmentId} />
    ));
}

/** One host's report, while this connection holds the scope the push RPCs need. */
function PresenceDestination({
  hub,
  environmentId,
}: {
  readonly hub: PresenceHub;
  readonly environmentId: EnvironmentId;
}) {
  const registry = useContext(RegistryContext);
  const canReport = useAtomValue(pushSettingsPermissionAtom(environmentId));
  // oxlint-disable-next-line t3code/react-effect-budget -- attaches this host to the presence hub while the scope allows, detaching on cleanup
  useEffect(() => {
    if (!canReport) return;
    return hub.attach((active) => openPresenceReport(registry, environmentId, active));
  }, [canReport, environmentId, hub, registry]);
  return null;
}
