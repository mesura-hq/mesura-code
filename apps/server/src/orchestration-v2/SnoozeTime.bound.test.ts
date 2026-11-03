import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

const sharedDayRule = vi.hoisted(() => ({ calls: [] as Array<[string, number]> }));

vi.mock("@t3tools/contracts", async (original) => {
  const contracts = await original<typeof import("@t3tools/contracts")>();
  return {
    ...contracts,
    MAX_SNOOZE_PRESET_MINUTES: 17,
    snoozeDaysAhead: (...args: Parameters<typeof contracts.snoozeDaysAhead>) => {
      sharedDayRule.calls.push(args);
      return contracts.snoozeDaysAhead(...args);
    },
  };
});

import { resolveSnoozeTime } from "./SnoozeTime.ts";

it.effect("snooze-zone rework P3-2: changing the shared bound changes duration validation", () =>
  Effect.gen(function* () {
    const context = {
      now: 0,
      settingTimeZone: null,
      deviceTimeZone: null,
      serverTimeZone: "UTC",
    };
    const accepted = yield* resolveSnoozeTime({ snoozeForMinutes: 17 }, context);
    expect(accepted.snoozedUntil).toBe("1970-01-01T00:17:00.000Z");
    const refused = yield* resolveSnoozeTime({ snoozeForMinutes: 18 }, context).pipe(Effect.flip);
    expect(refused.message).toBe("snoozeForMinutes must be an integer from 1 to 17 minutes.");
  }),
);

it.effect("snooze-day AC6 resolver spec: the server counts days with the contracts day rule", () =>
  Effect.gen(function* () {
    sharedDayRule.calls.length = 0;
    // 2026-03-08T02:00Z is Saturday 21:00 in New York and Sunday in UTC.
    const result = yield* resolveSnoozeTime(
      { snoozeDay: "monday", snoozeAt: "09:00", timeZone: "America/New_York" },
      {
        now: DateTime.toEpochMillis(DateTime.makeUnsafe("2026-03-08T02:00:00.000Z")),
        settingTimeZone: null,
        deviceTimeZone: null,
        serverTimeZone: "UTC",
      },
    );
    expect(result.snoozedUntilLocal).toBe("2026-03-09T09:00");
    expect(sharedDayRule.calls).toEqual([["monday", 6]]);
  }),
);
