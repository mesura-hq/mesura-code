import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";

vi.mock("@t3tools/contracts", async (original) => ({
  ...(await original<typeof import("@t3tools/contracts")>()),
  MAX_SNOOZE_PRESET_MINUTES: 17,
}));

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
