import { createFileRoute } from "@tanstack/react-router";

import { DictationSettingsPanel } from "../components/settings/DictationSettingsPanel";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";

/** Dictation runs on a server, so the page edits one environment at a time, as Providers does. */
function SettingsDictationRoute() {
  const { environment, scope } = useSettingsScope();
  if (!environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? `Reconnect ${scope.label} to set up dictation.`
          : "Connect an environment to set up dictation."}
      </p>
    );
  }
  return <DictationSettingsPanel environmentId={environment.environmentId} />;
}

export const Route = createFileRoute("/settings/dictation")({
  component: SettingsDictationRoute,
});
