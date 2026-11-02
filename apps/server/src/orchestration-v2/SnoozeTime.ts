import { isIanaTimeZone, MAX_SNOOZE_PRESET_MINUTES } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface SnoozeTimeInput {
  readonly snoozedUntil?: string | undefined;
  readonly snoozeForMinutes?: number | undefined;
  readonly snoozeUntilLocal?: string | undefined;
  readonly timeZone?: string | undefined;
}
export class SnoozeTimeError extends Schema.TaggedError<SnoozeTimeError>()("SnoozeTimeError", {
  reason: Schema.Literals([
    "inputs",
    "zoneWithoutLocal",
    "zone",
    "local",
    "minutes",
    "past",
    "absolute",
  ]),
}) {
  override get message(): string {
    switch (this.reason) {
      case "inputs":
        return "Snooze requires exactly one of snoozedUntil, snoozeForMinutes, or snoozeUntilLocal.";
      case "zoneWithoutLocal":
        return "timeZone is only valid with snoozeUntilLocal.";
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
export const resolveSnoozeTime = Effect.fn("SnoozeTime.resolve")(function* (
  input: SnoozeTimeInput,
  context: {
    readonly now: number;
    readonly settingTimeZone: string | null;
    readonly deviceTimeZone: string | null;
    readonly serverTimeZone: string;
  },
) {
  if (
    [input.snoozedUntil, input.snoozeForMinutes, input.snoozeUntilLocal].filter(
      (value) => value !== undefined,
    ).length !== 1
  ) {
    return yield* new SnoozeTimeError({ reason: "inputs" });
  }
  if (input.timeZone !== undefined && input.snoozeUntilLocal === undefined) {
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
  } else if (input.snoozeUntilLocal !== undefined) {
    const local = input.snoozeUntilLocal;
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
  if (DateTime.toEpochMillis(instant) <= context.now)
    return yield* new SnoozeTimeError({ reason: "past" });
  return {
    snoozedUntil: input.snoozedUntil ?? DateTime.formatIso(instant),
    snoozedUntilLocal: DateTime.toDate(DateTime.setZoneNamedUnsafe(instant, timeZone))
      .toISOString()
      .slice(0, 16),
    timeZone,
    timeZoneSource,
  };
});
