import { expect, it } from "@effect/vitest";
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import * as ClientTimeZone from "./ClientTimeZone.ts";
import { makeSnoozeThread } from "./threadSnooze.ts";

it.effect("snooze-zone rework P2-1: the snooze operation captures services at construction", () =>
  Effect.gen(function* () {
    const snooze = yield* Effect.gen(function* () {
      return makeSnoozeThread(() => Effect.succeed({ sequence: 7 }), {
        serverSettings: yield* ServerSettings.ServerSettingsService,
        clientTimeZone: yield* ClientTimeZone.ClientTimeZone,
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest(),
          Layer.succeed(ClientTimeZone.ClientTimeZone, {
            get: Effect.succeed("America/New_York"),
            report: () => Effect.void,
          }),
        ),
      ),
    );
    // The caller has no settings or client-zone service in its environment.
    const result = yield* snooze({
      commandId: CommandId.make("snooze-captured"),
      threadId: ThreadId.make("snooze-captured"),
      snoozeForMinutes: 60,
    });
    expect(result).toMatchObject({
      sequence: 7,
      timeZone: "America/New_York",
      timeZoneSource: "device",
    });
  }),
);
