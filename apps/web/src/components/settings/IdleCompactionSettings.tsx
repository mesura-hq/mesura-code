import {
  DEFAULT_UNIFIED_SETTINGS,
  globalIdleCompaction,
  IDLE_COMPACTION_MODES,
  type IdleCompactionMode,
} from "@t3tools/contracts/settings";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ScopedSwitch } from "./ScopedSwitch";
import { scopedIdleCompaction } from "./scopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/**
 * Mesura: the compaction switch, with upstream's mode select shown only while
 * it is on, so a mode not in effect is never on screen. A server from before the
 * switch compacts by its stored mode: it gets the select alone, and a selection
 * mixing both kinds gets neither.
 */
export function IdleCompactionSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { connectedEnvironments, targets } = useSettingsScope();
  const enabledMixed = useScopedSettingsMixed(["idleCompactionEnabled"]);
  const storedMode = scopedIdleCompaction(targets.length > 0 ? targets : [{ settings }]);
  const switchEnvironmentCount = connectedEnvironments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.idleCompactionSwitch,
  ).length;

  if (switchEnvironmentCount === 0 && connectedEnvironments.length > 0) {
    return (
      <IdleCompactionModeRow mixed={storedMode.mixed} neverAvailable={storedMode.neverAvailable} />
    );
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
        <IdleCompactionModeRow
          mixed={storedMode.mixed || enabledMixed}
          neverAvailable={storedMode.neverAvailable}
        />
      ) : null}
    </>
  );
}

function IdleCompactionModeRow({
  mixed,
  neverAvailable,
}: {
  readonly mixed: boolean;
  readonly neverAvailable: boolean;
}) {
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
            onClick={() => updateSettings({ idleCompaction: defaultMode })}
          />
        ) : null
      }
      control={
        <Select
          value={mixed ? null : mode}
          onValueChange={(value) => {
            const selected = IDLE_COMPACTION_MODES.find((candidate) => candidate.value === value);
            if (selected) updateSettings({ idleCompaction: selected.value });
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
              <SelectItem
                hideIndicator
                key={candidate.value}
                value={candidate.value}
                // A server from before modes has only the on/off switch, so it cannot store "Never".
                disabled={candidate.value === "off" && !neverAvailable}
              >
                {candidate.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
