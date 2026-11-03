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

// 2026-03-08T02:00Z is Saturday 2026-03-07 21:00 in New York and already Sunday in UTC.
const newYorkEvening = {
  ...context,
  now: DateTime.toEpochMillis(DateTime.makeUnsafe("2026-03-08T02:00:00.000Z")),
  deviceTimeZone: "America/New_York",
};

it.effect(
  "snooze-day AC1 resolver spec: tomorrow 09:00 is the New York tomorrow when UTC is a day ahead",
  () =>
    Effect.gen(function* () {
      const result = yield* resolveSnoozeTime(
        { snoozeDay: "tomorrow", snoozeAt: "09:00" },
        newYorkEvening,
      );
      expect(result).toEqual({
        snoozedUntil: "2026-03-08T13:00:00.000Z",
        snoozedUntilLocal: "2026-03-08T09:00",
        timeZone: "America/New_York",
        timeZoneSource: "device",
      });
    }),
);

it.effect("snooze-day AC2 resolver spec: today at a time still ahead wakes later today", () =>
  Effect.gen(function* () {
    const result = yield* resolveSnoozeTime(
      { snoozeDay: "today", snoozeAt: "22:30" },
      newYorkEvening,
    );
    expect(result).toMatchObject({
      snoozedUntil: "2026-03-08T03:30:00.000Z",
      snoozedUntilLocal: "2026-03-07T22:30",
      timeZone: "America/New_York",
    });
  }),
);

it.effect.each(["09:00", "21:00"])(
  "snooze-day AC2 resolver spec: today at %s already passed names the zone's local time",
  (snoozeAt) =>
    Effect.gen(function* () {
      const error = yield* resolveSnoozeTime({ snoozeDay: "today", snoozeAt }, newYorkEvening).pipe(
        Effect.flip,
      );
      expect(error).toBeInstanceOf(SnoozeTimeError);
      expect(error.reason).toBe("dayPassed");
      expect(error.message).toContain(snoozeAt);
      expect(error.message).toContain("America/New_York");
      expect(error.message).toContain("21:00");
      expect(error.message).toMatch(/tomorrow/i);
    }),
);

it.effect.each([
  // New York is Saturday while UTC is already Sunday.
  {
    zone: "America/New_York",
    now: "2026-03-08T02:00:00.000Z",
    day: "sunday",
    until: "2026-03-08T13:00:00.000Z",
    local: "2026-03-08T09:00",
  },
  {
    zone: "America/New_York",
    now: "2026-03-08T02:00:00.000Z",
    day: "saturday",
    until: "2026-03-14T13:00:00.000Z",
    local: "2026-03-14T09:00",
  },
  {
    zone: "America/New_York",
    now: "2026-03-08T02:00:00.000Z",
    day: "monday",
    until: "2026-03-09T13:00:00.000Z",
    local: "2026-03-09T09:00",
  },
  // Tokyo is already Sunday while UTC is still Saturday.
  {
    zone: "Asia/Tokyo",
    now: "2026-03-07T18:15:00.000Z",
    day: "sunday",
    until: "2026-03-15T00:00:00.000Z",
    local: "2026-03-15T09:00",
  },
  {
    zone: "Asia/Tokyo",
    now: "2026-03-07T18:15:00.000Z",
    day: "saturday",
    until: "2026-03-14T00:00:00.000Z",
    local: "2026-03-14T09:00",
  },
] as const)(
  "snooze-day AC3 resolver spec: $day from $now in $zone uses the zone's weekday",
  ({ zone, now, day, until, local }) =>
    Effect.gen(function* () {
      const result = yield* resolveSnoozeTime(
        { snoozeDay: day, snoozeAt: "09:00" },
        {
          ...context,
          now: DateTime.toEpochMillis(DateTime.makeUnsafe(now)),
          settingTimeZone: zone,
        },
      );
      expect(result).toMatchObject({
        snoozedUntil: until,
        snoozedUntilLocal: local,
        timeZone: zone,
        timeZoneSource: "setting",
      });
    }),
);

it.effect("snooze-day AC4 resolver spec: timeZone is accepted with snoozeDay", () =>
  Effect.gen(function* () {
    const result = yield* resolveSnoozeTime(
      { snoozeDay: "tomorrow", snoozeAt: "09:00", timeZone: "Asia/Tokyo" },
      newYorkEvening,
    );
    // Tokyo is already Sunday 2026-03-08 11:00, so tomorrow is Monday 2026-03-09.
    expect(result).toEqual({
      snoozedUntil: "2026-03-09T00:00:00.000Z",
      snoozedUntilLocal: "2026-03-09T09:00",
      timeZone: "Asia/Tokyo",
      timeZoneSource: "argument",
    });
  }),
);

const dayRefusals = [
  [
    "day without clock time",
    { snoozeDay: "tomorrow" },
    /snoozeDay[^.]*snoozeAt|snoozeAt[^.]*snoozeDay/i,
  ],
  [
    "clock time without day",
    { snoozeAt: "09:00" },
    /snoozeDay[^.]*snoozeAt|snoozeAt[^.]*snoozeDay/i,
  ],
  [
    "clock time without day plus zone",
    { snoozeAt: "09:00", timeZone: "UTC" },
    /snoozeDay[^.]*snoozeAt|snoozeAt[^.]*snoozeDay/i,
  ],
  ["single-digit hour", { snoozeDay: "tomorrow", snoozeAt: "9:00" }, /HH:MM/],
  ["hour 24", { snoozeDay: "tomorrow", snoozeAt: "24:00" }, /HH:MM/],
  ["minute 60", { snoozeDay: "tomorrow", snoozeAt: "09:60" }, /HH:MM/],
  ["clock time with seconds", { snoozeDay: "tomorrow", snoozeAt: "09:00:00" }, /HH:MM/],
  ["clock time without colon", { snoozeDay: "tomorrow", snoozeAt: "0900" }, /HH:MM/],
  [
    "day plus minutes",
    { snoozeDay: "tomorrow", snoozeAt: "09:00", snoozeForMinutes: 60 },
    /exactly one[^.]*snoozeDay/i,
  ],
  [
    "day plus absolute",
    { snoozeDay: "tomorrow", snoozeAt: "09:00", snoozedUntil: "2026-03-09T13:00:00Z" },
    /exactly one[^.]*snoozeDay/i,
  ],
  [
    "day plus local",
    { snoozeDay: "tomorrow", snoozeAt: "09:00", snoozeUntilLocal: "2026-03-09T09:00" },
    /exactly one[^.]*snoozeDay/i,
  ],
  [
    "day with unknown zone",
    { snoozeDay: "tomorrow", snoozeAt: "09:00", timeZone: "Mars/Olympus" },
    /zone|IANA/i,
  ],
] as const;

it.effect.each(dayRefusals.map(([title, input, message]) => ({ title, input, message })))(
  "snooze-day AC4 resolver spec: refuses $title",
  ({ input, message }) =>
    Effect.gen(function* () {
      const error = yield* resolveSnoozeTime(input, newYorkEvening).pipe(Effect.flip);
      expect(error).toBeInstanceOf(SnoozeTimeError);
      expect(error.message).toMatch(message);
    }),
);

it.effect.each([
  // Saturday 2027-03-13 15:00 EST; 2027-03-14 02:30 does not exist and moves forward by the gap.
  {
    title: "spring-forward gap",
    now: "2027-03-13T20:00:00.000Z",
    snoozeAt: "02:30",
    asked: "2027-03-14T02:30",
    until: "2027-03-14T07:30:00.000Z",
    local: "2027-03-14T03:30",
  },
  // Saturday 2027-11-06 16:00 EDT; 2027-11-07 01:30 occurs twice and takes the earlier one.
  {
    title: "fall-back overlap",
    now: "2027-11-06T20:00:00.000Z",
    snoozeAt: "01:30",
    asked: "2027-11-07T01:30",
    until: "2027-11-07T05:30:00.000Z",
    local: "2027-11-07T01:30",
  },
  // Saturday 2027-03-13 23:30 EST; a 24-hour step would land on Monday 00:30 EDT.
  {
    title: "calendar step over a 23-hour day",
    now: "2027-03-14T04:30:00.000Z",
    snoozeAt: "23:00",
    asked: "2027-03-14T23:00",
    until: "2027-03-15T03:00:00.000Z",
    local: "2027-03-14T23:00",
  },
] as const)(
  "snooze-day AC5 resolver spec: tomorrow across the $title in New York",
  ({ now, snoozeAt, asked, until, local }) =>
    Effect.gen(function* () {
      const result = yield* resolveSnoozeTime(
        { snoozeDay: "tomorrow", snoozeAt, timeZone: "America/New_York" },
        { ...context, now: DateTime.toEpochMillis(DateTime.makeUnsafe(now)) },
      );
      expect(result).toMatchObject({ snoozedUntil: until, snoozedUntilLocal: local });
      const viaLocal = yield* resolveSnoozeTime(
        { snoozeUntilLocal: asked, timeZone: "America/New_York" },
        { ...context, now: DateTime.toEpochMillis(DateTime.makeUnsafe(now)) },
      );
      expect(result.snoozedUntil).toBe(viaLocal.snoozedUntil);
    }),
);
