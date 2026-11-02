import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { createElement, useEffect, useEffectEvent } from "react";
import { connectionAtomRuntime } from "../connection/runtime";
import { useDeviceTimeZone } from "./deviceTimeZone";
import { useEnvironments } from "./environments";
import { useAtomCommand } from "./use-atom-command";

const reportClientTimeZone = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "server:reportClientTimeZone",
  tag: WS_METHODS.serverReportClientTimeZone,
});

// One destination per connected environment remounts after a reconnect.
export function ClientTimeZoneReporter() {
  const { environments } = useEnvironments();
  const timeZone = useDeviceTimeZone();
  return environments
    .filter(({ connection }) => connection.phase === "connected")
    .map(({ environmentId }) =>
      createElement(Destination, { key: environmentId, environmentId, timeZone }),
    );
}

function Destination({
  environmentId,
  timeZone,
}: {
  readonly environmentId: EnvironmentId;
  readonly timeZone: string;
}) {
  const report = useAtomCommand(reportClientTimeZone, { reportFailure: false });
  const send = useEffectEvent((request: Parameters<typeof report>[0]) => {
    void report(request);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports external Intl state on connect, zone change, focus, and becoming visible
  useEffect(() => {
    send({ environmentId, input: { timeZone } });
    const reportCurrent = () =>
      send({
        environmentId,
        input: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      });
    const onVisible = () => {
      if (document.visibilityState === "visible") reportCurrent();
    };
    const onFocus = () => reportCurrent();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [environmentId, timeZone]);
  return null;
}
