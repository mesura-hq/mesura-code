import {
  isIanaTimeZone,
  MAX_SNOOZE_PRESET_MINUTES,
  snoozeDaysAhead,
  type SnoozePresetDay,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface SnoozeTimeInput {
  readonly snoozedUntil?: string | undefined;
  readonly snoozeForMinutes?: number | undefined;
  readonly snoozeUntilLocal?: string | undefined;
  readonly snoozeDay?: SnoozePresetDay | undefined;
  readonly snoozeAt?: string | undefined;
  readonly timeZone?: string | undefined;
}
export class SnoozeTimeError extends Schema.TaggedError<SnoozeTimeError>()("SnoozeTimeError", {
  reason: Schema.Literals([
    "inputs",
    "dayPair",
    "clock",
    "dayPassed",
    "zoneWithoutLocal",
    "zone",
    "local",
    "minutes",
    "past",
    "absolute",
  ]),
  snoozeAt: Schema.optional(Schema.String),
  timeZone: Schema.optional(Schema.String),
  localNow: Schema.optional(Schema.String),
}) {
  override get message(): string {
    switch (this.reason) {
      case "inputs":
        return "Snooze requires exactly one of snoozedUntil, snoozeForMinutes, snoozeUntilLocal, or snoozeDay with snoozeAt.";
      case "dayPair":
        return "snoozeDay and snoozeAt must be passed together.";
      case "clock":
        return "snoozeAt must be a clock time in HH:MM format, from 00:00 to 23:59.";
      case "dayPassed":
        return `Today ${this.snoozeAt} has already passed in ${this.timeZone} (now ${this.localNow}). Use tomorrow or a later day.`;
      case "zoneWithoutLocal":
        return "timeZone is only valid with snoozeUntilLocal or snoozeDay.";
      case "zone":
        return "Use a valid IANA time zone name.";
      case "local":
        return "Use a valid local time in YYYY-MM-DDTHH:MM format.";
      case "minutes":
        return (
          "snoozeForMinutes must be an integer from 1 to " + MAX_SNOOZE_PRESET_MINUTES + " minutes."
        );
      case "past":
        return "The snooze wake time must be in the future, not the past.";
      case "absolute":
        return "snoozedUntil must be a valid absolute date and time.";
    }
  }
}
/** The wall-clock `YYYY-MM-DDTHH:MM` of an instant in a named zone. */
const localDateTime = (instant: DateTime.DateTime, timeZone: string): string =>
  DateTime.toDate(DateTime.setZoneNamedUnsafe(instant, timeZone)).toISOString().slice(0, 16);

export const resolveSnoozeTime = Effect.fn("SnoozeTime.resolve")(function* (
  input: SnoozeTimeInput,
  context: {
    readonly now: number;
    readonly settingTimeZone: string | null;
    readonly deviceTimeZone: string | null;
    readonly serverTimeZone: string;
  },
) {
  const hasDayForm = input.snoozeDay !== undefined || input.snoozeAt !== undefined;
  if (
    [input.snoozedUntil, input.snoozeForMinutes, input.snoozeUntilLocal].filter(
      (value) => value !== undefined,
    ).length +
      (hasDayForm ? 1 : 0) !==
    1
  ) {
    return yield* new SnoozeTimeError({ reason: "inputs" });
  }
  if (hasDayForm && (input.snoozeDay === undefined || input.snoozeAt === undefined)) {
    return yield* new SnoozeTimeError({ reason: "dayPair" });
  }
  if (input.timeZone !== undefined && input.snoozeUntilLocal === undefined && !hasDayForm) {
    return yield* new SnoozeTimeError({ reason: "zoneWithoutLocal" });
  }
  const [timeZone, timeZoneSource] =
    input.timeZone !== undefined
      ? ([input.timeZone, "argument"] as const)
      : context.settingTimeZone !== null
        ? ([context.settingTimeZone, "setting"] as const)
        : context.deviceTimeZone !== null
          ? ([context.deviceTimeZone, "device"] as const)
          : ([context.serverTimeZone, "server"] as const);
  if (!isIanaTimeZone(timeZone)) return yield* new SnoozeTimeError({ reason: "zone" });
  let instant: DateTime.DateTime;
  if (input.snoozeForMinutes !== undefined) {
    const minutes = input.snoozeForMinutes;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_SNOOZE_PRESET_MINUTES) {
      return yield* new SnoozeTimeError({ reason: "minutes" });
    }
    instant = DateTime.makeUnsafe(context.now + minutes * 60000);
  } else if (input.snoozeUntilLocal !== undefined || hasDayForm) {
    let local = input.snoozeUntilLocal;
    if (local === undefined) {
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.snoozeAt!)) {
        return yield* new SnoozeTimeError({ reason: "clock" });
      }
      // Calendar arithmetic on the zone's local date, so a 23- or 25-hour day cannot shift it.
      const today = DateTime.makeUnsafe(
        localDateTime(DateTime.makeUnsafe(context.now), timeZone).slice(0, 10) + "T00:00:00.000Z",
      );
      const wakeDate = DateTime.add(today, {
        days: snoozeDaysAhead(input.snoozeDay!, DateTime.getPartUtc(today, "weekDay")),
      });
      local = DateTime.formatIso(wakeDate).slice(0, 10) + "T" + input.snoozeAt;
    }
    const parsed = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)
      ? DateTime.make(local + ":00.000Z")
      : Option.none<DateTime.Utc>();
    // Round-tripping rejects calendar overflow, including impossible dates and 24:00.
    if (Option.isNone(parsed) || DateTime.formatIso(parsed.value).slice(0, 16) !== local) {
      return yield* new SnoozeTimeError({ reason: "local" });
    }
    // DST: choose the earlier instant in overlaps and move forward by the gap for missing times.
    instant = DateTime.makeZonedUnsafe(parsed.value, {
      timeZone,
      adjustForTimeZone: true,
      disambiguation: "compatible",
    });
  } else {
    const parsed = DateTime.make(input.snoozedUntil!);
    if (Option.isNone(parsed)) return yield* new SnoozeTimeError({ reason: "absolute" });
    instant = parsed.value;
  }
  if (DateTime.toEpochMillis(instant) <= context.now) {
    return yield* input.snoozeDay === "today"
      ? new SnoozeTimeError({
          reason: "dayPassed",
          snoozeAt: input.snoozeAt,
          timeZone,
          localNow: localDateTime(DateTime.makeUnsafe(context.now), timeZone).slice(11),
        })
      : new SnoozeTimeError({ reason: "past" });
  }
  return {
    snoozedUntil: input.snoozedUntil ?? DateTime.formatIso(instant),
    snoozedUntilLocal: localDateTime(instant, timeZone),
    timeZone,
    timeZoneSource,
  };
});
