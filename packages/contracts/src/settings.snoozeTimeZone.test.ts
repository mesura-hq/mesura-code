import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_SNOOZE_PRESETS,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);

it("snooze-zone AC5 spec: server settings default to Device and retain valid IANA zone patches", () => {
  const settings = decodeSettings({});
  expect(settings).toHaveProperty("snoozeTimeZone", null);
  expect(DEFAULT_SERVER_SETTINGS).toHaveProperty("snoozeTimeZone", null);
  for (const timeZone of [
    null,
    "UTC",
    "America/Argentina/Buenos_Aires",
    "America/New_York",
    "Asia/Kathmandu",
  ]) {
    expect(decodePatch({ snoozeTimeZone: timeZone })).toEqual({
      snoozeTimeZone: timeZone,
    });
    expect(decodeSettings({ snoozeTimeZone: timeZone })).toHaveProperty("snoozeTimeZone", timeZone);
  }
});

it("snooze-zone AC5 spec: settings reject invalid IANA zones rather than retaining an unusable override", () => {
  for (const timeZone of ["Mars/Olympus", "", "not a zone", "+03:00", 42]) {
    expect(() => decodePatch({ snoozeTimeZone: timeZone })).toThrow();
    expect(() => decodeSettings({ snoozeTimeZone: timeZone })).toThrow();
  }
});

it("snooze-zone guard: defaults and patches retain the existing snooze presets", () => {
  expect(decodeSettings({}).snoozePresets).toEqual(DEFAULT_SNOOZE_PRESETS);
  const snoozePresets = [
    { kind: "after", minutes: 90 },
    { kind: "at", day: "tomorrow", time: "09:30" },
  ];
  expect(decodePatch({ snoozePresets })).toEqual({
    snoozePresets,
  });
});
