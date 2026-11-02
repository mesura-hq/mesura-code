import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { MAX_SNOOZE_PRESET_MINUTES } from "@t3tools/contracts";
import { resolveSnoozeTime, SnoozeTimeError } from "./SnoozeTime.ts";

const context = {
  now: DateTime.toEpochMillis(DateTime.makeUnsafe("2026-03-07T18:15:00.000Z")),
  settingTimeZone: null,
  deviceTimeZone: null,
  serverTimeZone: "UTC",
};

it.effect.each([
  {
    source: "argument",
    input: { timeZone: "America/New_York" },
    zones: { settingTimeZone: "Asia/Tokyo", deviceTimeZone: "Europe/Madrid" },
    zone: "America/New_York",
    until: "2026-03-08T13:00:00.000Z",
  },
  {
    source: "setting",
    input: {},
    zones: { settingTimeZone: "America/New_York", deviceTimeZone: "Asia/Tokyo" },
    zone: "America/New_York",
    until: "2026-03-08T13:00:00.000Z",
  },
  {
    source: "device",
    input: {},
    zones: { deviceTimeZone: "America/New_York" },
    zone: "America/New_York",
    until: "2026-03-08T13:00:00.000Z",
  },
  {
    source: "server",
    input: {},
    zones: { serverTimeZone: "America/New_York" },
    zone: "America/New_York",
    until: "2026-03-08T13:00:00.000Z",
  },
] as const)(
  "snooze-zone AC2 resolver spec: $source wins in the zone precedence and uses the target date DST offset",
  (source) =>
    Effect.gen(function* () {
      const result = yield* resolveSnoozeTime(
        { snoozeUntilLocal: "2026-03-08T09:00", ...source.input },
        { ...context, ...source.zones },
      );
      expect(result).toMatchObject({
        snoozedUntil: source.until,
        timeZone: source.zone,
        timeZoneSource: source.source,
      });
    }),
);

it.effect(
  "snooze-zone AC1 resolver spec: integer minute bounds resolve from the injected instant",
  () =>
    Effect.gen(function* () {
      for (const [minutes, expected] of [
        [1, "2026-03-07T18:16:00.000Z"],
        [43200, "2026-04-06T18:15:00.000Z"],
      ] as const) {
        expect(yield* resolveSnoozeTime({ snoozeForMinutes: minutes }, context)).toMatchObject({
          snoozedUntil: expected,
        });
      }
    }),
);

const refusals = [
  ["no input", {}, /exactly one|one of/i],
  [
    "absolute plus minutes",
    { snoozedUntil: "2026-03-08T13:00:00Z", snoozeForMinutes: 60 },
    /exactly one|one of/i,
  ],
  [
    "absolute plus local",
    { snoozedUntil: "2026-03-08T13:00:00Z", snoozeUntilLocal: "2026-03-08T09:00" },
    /exactly one|one of/i,
  ],
  [
    "minutes plus local",
    { snoozeForMinutes: 60, snoozeUntilLocal: "2026-03-08T09:00" },
    /exactly one|one of/i,
  ],
  [
    "all inputs",
    {
      snoozedUntil: "2026-03-08T13:00:00Z",
      snoozeForMinutes: 60,
      snoozeUntilLocal: "2026-03-08T09:00",
    },
    /exactly one|one of/i,
  ],
  ["zone alone", { timeZone: "Europe/Madrid" }, /snoozeUntilLocal|local|exactly one|one of/i],
  [
    "zone plus absolute",
    { snoozedUntil: "2026-03-08T13:00:00Z", timeZone: "Europe/Madrid" },
    /timeZone.*snoozeUntilLocal|zone.*local/i,
  ],
  [
    "zone plus minutes",
    { snoozeForMinutes: 60, timeZone: "Europe/Madrid" },
    /timeZone.*snoozeUntilLocal|zone.*local/i,
  ],
  [
    "unknown IANA zone",
    { snoozeUntilLocal: "2026-03-08T09:00", timeZone: "Mars/Olympus" },
    /zone|IANA/i,
  ],
  ["non-ISO local time", { snoozeUntilLocal: "tomorrow at nine" }, /YYYY-MM-DDTHH:MM|local time/i],
  ["local seconds", { snoozeUntilLocal: "2026-03-08T09:00:00" }, /YYYY-MM-DDTHH:MM|local time/i],
  ["local UTC suffix", { snoozeUntilLocal: "2026-03-08T09:00Z" }, /YYYY-MM-DDTHH:MM|local time/i],
  ["impossible calendar date", { snoozeUntilLocal: "2026-02-30T09:00" }, /date|local time/i],
  ["invalid clock hour", { snoozeUntilLocal: "2026-03-08T25:00" }, /local time|HH:MM|hour/i],
  ["past absolute instant", { snoozedUntil: "2026-03-06T13:00:00Z" }, /past|future/i],
  ["past local instant", { snoozeUntilLocal: "2026-03-06T09:00", timeZone: "UTC" }, /past|future/i],
  ["zero minutes", { snoozeForMinutes: 0 }, /minutes|1|43200/i],
  ["negative minutes", { snoozeForMinutes: -1 }, /minutes|1|43200/i],
  ["fractional minutes", { snoozeForMinutes: 1.5 }, /minutes|integer/i],
  ["too many minutes", { snoozeForMinutes: 43201 }, /minutes|43200/i],
] as const;

it.effect.each(refusals.map(([title, input, message]) => ({ title, input, message })))(
  "snooze-zone AC3 resolver spec: refuses $title",
  ({ input, message }) =>
    Effect.gen(function* () {
      const error = yield* resolveSnoozeTime(input, context).pipe(Effect.flip);
      expect(error.message).toMatch(message);
    }),
);

it.effect.each([
  { local: "2027-03-14T02:30", until: "2027-03-14T07:30:00.000Z" },
  { local: "2027-11-07T01:30", until: "2027-11-07T05:30:00.000Z" },
])("snooze-zone rework P3-1: compatible DST resolution of $local", ({ local, until }) =>
  Effect.gen(function* () {
    const result = yield* resolveSnoozeTime(
      { snoozeUntilLocal: local, timeZone: "America/New_York" },
      context,
    );
    expect(result).toMatchObject({ snoozedUntil: until });
  }),
);

it.effect.each([
  { kind: "minutes", input: { snoozeForMinutes: 90 }, wake: "2026-03-07T14:45" },
  { kind: "absolute", input: { snoozedUntil: "2026-03-08T13:00:00Z" }, wake: "2026-03-08T09:00" },
  { kind: "local", input: { snoozeUntilLocal: "2026-03-08T09:00" }, wake: "2026-03-08T09:00" },
])("snooze-zone rework P2-2: $kind returns the wake time in the resolved zone", ({ input, wake }) =>
  Effect.gen(function* () {
    const result = yield* resolveSnoozeTime(input, {
      ...context,
      deviceTimeZone: "America/New_York",
    });
    expect(result).toMatchObject({ snoozedUntilLocal: wake, timeZone: "America/New_York" });
  }),
);

it.effect("snooze-zone rework P3-2: duration validation uses the shared preset bound", () =>
  Effect.gen(function* () {
    const error = yield* resolveSnoozeTime(
      { snoozeForMinutes: MAX_SNOOZE_PRESET_MINUTES + 1 },
      context,
    ).pipe(Effect.flip);
    expect(error).toBeInstanceOf(SnoozeTimeError);
    expect(error.message).toBe(
      "snoozeForMinutes must be an integer from 1 to " + MAX_SNOOZE_PRESET_MINUTES + " minutes.",
    );
  }),
);
