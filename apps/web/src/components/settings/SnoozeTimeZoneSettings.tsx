import { useDeviceTimeZone } from "../../state/deviceTimeZone";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow } from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function SnoozeTimeZoneRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["snoozeTimeZone"]);
  const deviceZone = useDeviceTimeZone();
  const zones = Array.from(
    new Set([
      "UTC",
      deviceZone,
      ...(settings.snoozeTimeZone ? [settings.snoozeTimeZone] : []),
      ...Intl.supportedValuesOf("timeZone"),
    ]),
  ).sort();
  const deviceLabel = "Device (" + deviceZone + ")";
  const items = { device: deviceLabel, ...Object.fromEntries(zones.map((zone) => [zone, zone])) };
  return (
    <SettingsRow
      {...searchableSetting("snooze-time-zone")}
      serverScoped
      settingKeys={["snoozeTimeZone"]}
      title="Time zone"
      description="The time zone agents use for snooze clock times. Device follows the device you last connected or used."
    >
      <Select
        value={mixed ? null : (settings.snoozeTimeZone ?? "device")}
        items={items}
        onValueChange={(value) => {
          if (value !== null) updateSettings({ snoozeTimeZone: value === "device" ? null : value });
        }}
      >
        <SelectTrigger aria-label="Time zone" className="w-full max-w-sm">
          <SelectValue placeholder="Mixed" />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="device">{deviceLabel}</SelectItem>
          {zones.map((zone) => (
            <SelectItem key={zone} value={zone}>
              {zone}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </SettingsRow>
  );
}
