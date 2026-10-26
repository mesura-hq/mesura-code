import {
  DEFAULT_UNIFIED_SETTINGS,
  globalIdleCompaction,
  IDLE_COMPACTION_MODES,
  type IdleCompactionMode,
  idleCompactionPatch,
} from "@t3tools/contracts/settings";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/**
 * Mesura: the switch that lets the app suggest or start compaction, and below
 * it upstream's mode select. The select shows only while the switch is on, so
 * a stored mode that is not in effect is never on screen. A server from before
 * the switch keeps compacting by its stored mode, so it gets upstream's select
 * alone, and a selection mixing both kinds gets neither.
 */
export function IdleCompactionSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { connectedEnvironments } = useSettingsScope();
  const enabledMixed = useScopedSettingsMixed(["idleCompactionEnabled"]);
  const storedModeMixed = useScopedSettingsMixed(["idleCompaction", "compactIdleThreads"]);
  const switchEnvironmentCount = connectedEnvironments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.idleCompactionSwitch,
  ).length;

  if (switchEnvironmentCount === 0 && connectedEnvironments.length > 0) {
    return <IdleCompactionModeRow mixed={storedModeMixed} />;
  }
  if (switchEnvironmentCount < connectedEnvironments.length) {
    return (
      <SettingsRow
        {...searchableSetting("idle-compaction")}
        description="Some selected environments run a server from before this switch, and they compact idle threads by their own mode. Select one environment to change idle compaction."
      />
    );
  }

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["idleCompactionEnabled"]}
        {...searchableSetting("idle-compaction")}
        description="Let a long idle Claude thread compact without you asking: a Compact chip when you return, or a compaction before its prompt cache expires. Off, threads compact only by hand, with /compact or Compact context."
        resetAction={
          settings.idleCompactionEnabled !== DEFAULT_UNIFIED_SETTINGS.idleCompactionEnabled ? (
            <SettingResetButton
              label="idle compaction"
              onClick={() =>
                updateSettings({
                  idleCompactionEnabled: DEFAULT_UNIFIED_SETTINGS.idleCompactionEnabled,
                })
              }
            />
          ) : null
        }
        control={
          <ScopedSwitch
            settingKeys={["idleCompactionEnabled"]}
            checked={settings.idleCompactionEnabled}
            onCheckedChange={(checked) =>
              updateSettings({ idleCompactionEnabled: Boolean(checked) })
            }
            aria-label="Idle compaction"
          />
        }
      />

      {settings.idleCompactionEnabled || enabledMixed ? (
        // With the switch off in some environments, their mode in effect is "Never".
        <IdleCompactionModeRow mixed={storedModeMixed || enabledMixed} />
      ) : null}
    </>
  );
}

function IdleCompactionModeRow({ mixed }: { readonly mixed: boolean }) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mode = globalIdleCompaction(settings);
  const defaultMode = globalIdleCompaction(DEFAULT_UNIFIED_SETTINGS);

  return (
    <SettingsRow
      serverScoped
      settingKeys={["idleCompaction", "compactIdleThreads"]}
      mixed={mixed}
      {...searchableSetting("compact-idle-threads")}
      description={
        mixed
          ? "The selected environments compact idle Claude threads differently."
          : "When to compact an idle Claude thread over 200,000 tokens: after you return, just before its prompt cache expires, or never. Each Claude provider can override this."
      }
      resetAction={
        mode !== defaultMode ? (
          <SettingResetButton
            label="compact idle threads"
            onClick={() => updateSettings(idleCompactionPatch(settings, defaultMode))}
          />
        ) : null
      }
      control={
        <Select
          value={mixed ? null : mode}
          onValueChange={(value) => {
            const selected = IDLE_COMPACTION_MODES.find((candidate) => candidate.value === value);
            if (selected) updateSettings(idleCompactionPatch(settings, selected.value));
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Compact idle threads">
            <SelectValue>
              {(value: IdleCompactionMode | null) =>
                value === null
                  ? "Mixed"
                  : IDLE_COMPACTION_MODES.find((candidate) => candidate.value === value)?.label
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {IDLE_COMPACTION_MODES.map((candidate) => (
              <SelectItem hideIndicator key={candidate.value} value={candidate.value}>
                {candidate.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
