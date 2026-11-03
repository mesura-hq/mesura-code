import type { CommandId, ThreadId, OrchestrationV2ServerCommand } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as ClientTimeZone from "./ClientTimeZone.ts";
import { resolveSnoozeTime, type SnoozeTimeInput } from "./SnoozeTime.ts";
import type * as ServerSettings from "../serverSettings.ts";

// The thread service supplies its dispatch path, including import and receipt handling.
export const makeSnoozeThread = <E>(
  dispatch: (
    command: OrchestrationV2ServerCommand,
  ) => Effect.Effect<{ readonly sequence: number }, E>,
  services: {
    readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
    readonly clientTimeZone: Context.Service.Shape<typeof ClientTimeZone.ClientTimeZone>;
  },
) =>
  Effect.fn("ThreadManagementService.snoozeThread")(function* (
    input: SnoozeTimeInput & { readonly commandId: CommandId; readonly threadId: ThreadId },
  ) {
    const now = yield* Clock.currentTimeMillis;
    const resolved = yield* resolveSnoozeTime(input, {
      now,
      settingTimeZone: (yield* services.serverSettings.getSettings.pipe(Effect.orDie))
        .snoozeTimeZone,
      deviceTimeZone: yield* services.clientTimeZone.get,
      serverTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    const result = yield* dispatch({
      type: "thread.snooze",
      commandId: input.commandId,
      threadId: input.threadId,
      snoozedUntil: resolved.snoozedUntil,
    });
    return { sequence: result.sequence, ...resolved };
  });
