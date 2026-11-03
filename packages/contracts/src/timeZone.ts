// Mesura: shared validation for device reports, settings, and agent snoozes.
import * as Schema from "effect/Schema";

export function isIanaTimeZone(value: string): boolean {
  if (!value || /^[+-]/.test(value)) return false;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

export const IanaTimeZone = Schema.String.check(
  Schema.makeFilter(isIanaTimeZone, { message: "Expected a valid IANA time zone name." }),
);

export class ClientTimeZoneError extends Schema.TaggedError<ClientTimeZoneError>()(
  "ClientTimeZoneError",
  { operation: Schema.Literals(["read", "decode", "persist"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to ${this.operation} the client time zone.`;
  }
}
