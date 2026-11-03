// Entry point: `snoozeDaysAhead` from the `@t3tools/contracts` package root, the day rule the
// sidebar presets and the server snooze resolver share.
import { expect, it } from "vite-plus/test";

import * as Contracts from "./index.ts";

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

/** Walks forward one calendar day at a time until the weekday matches, never stopping today. */
function nextOccurrence(weekdayIndex: number, todayWeekday: number): number {
  for (let days = 1; days <= 7; days++) {
    if ((todayWeekday + days) % 7 === weekdayIndex) return days;
  }
  throw new Error("unreachable");
}

it("snooze-day AC6 spec: the package root exports the shared day rule and its weekday table", () => {
  expect(typeof Contracts.snoozeDaysAhead).toBe("function");
  expect(Contracts.SNOOZE_WEEKDAY_INDEX).toEqual({
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  });
});

it.each([0, 1, 2, 3, 4, 5, 6])(
  "snooze-day AC3 spec: every day word resolves from today's weekday %i",
  (todayWeekday) => {
    expect(Contracts.snoozeDaysAhead("today", todayWeekday)).toBe(0);
    expect(Contracts.snoozeDaysAhead("tomorrow", todayWeekday)).toBe(1);
    WEEKDAYS.forEach((day, weekdayIndex) => {
      expect(Contracts.snoozeDaysAhead(day, todayWeekday), day).toBe(
        nextOccurrence(weekdayIndex, todayWeekday),
      );
    });
    expect(Contracts.snoozeDaysAhead(WEEKDAYS[todayWeekday]!, todayWeekday)).toBe(7);
  },
);
