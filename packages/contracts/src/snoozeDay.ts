import type { SnoozePresetDay } from "./settings.ts";

/** `Date#getDay` numbering, Sunday first. */
export const SNOOZE_WEEKDAY_INDEX = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
} as const;

/** Calendar days from today to `day`; a weekday that is today means next week's. */
export function snoozeDaysAhead(day: SnoozePresetDay, todayWeekday: number): number {
  if (day === "today") return 0;
  if (day === "tomorrow") return 1;
  return (SNOOZE_WEEKDAY_INDEX[day] - todayWeekday + 7) % 7 || 7;
}
