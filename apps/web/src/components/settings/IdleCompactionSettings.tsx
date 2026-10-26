import {
  DEFAULT_UNIFIED_SETTINGS,
  globalIdleCompaction,
  IDLE_COMPACTION_MODES,
  idleCompactionPatch,
} from "@t3tools/contracts/settings";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ScopedSwitch } from "./ScopedSwitch";
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
 * a stored mode that is not in effect is never on screen.
 */
export function IdleCompactionSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const enabledMixed = useScopedSettingsMixed(["idleCompactionEnabled"]);
  const mode = globalIdleCompaction(settings);
  const defaultMode = globalIdleCompaction(DEFAULT_UNIFIED_SETTINGS);

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
        <SettingsRow
          serverScoped
          settingKeys={["idleCompaction", "compactIdleThreads"]}
          {...searchableSetting("compact-idle-threads")}
          description="When to compact an idle Claude thread over 200,000 tokens: after you return, just before its prompt cache expires, or never. Each Claude provider can override this."
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
              value={mode}
              onValueChange={(value) => {
                const selected = IDLE_COMPACTION_MODES.find(
                  (candidate) => candidate.value === value,
                );
                if (selected) updateSettings(idleCompactionPatch(settings, selected.value));
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Compact idle threads">
                <SelectValue>
                  {IDLE_COMPACTION_MODES.find((candidate) => candidate.value === mode)?.label}
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
      ) : null}
    </>
  );
}
