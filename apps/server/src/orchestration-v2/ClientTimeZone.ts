import { ClientTimeZoneError, IanaTimeZone } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";

export class ClientTimeZone extends Context.Reference<{
  readonly get: Effect.Effect<string | null>;
  readonly report: (timeZone: string) => Effect.Effect<void, ClientTimeZoneError>;
}>("t3/orchestration-v2/ClientTimeZone", {
  // Runtimes without device reporting use the server zone; production overrides this with layer.
  defaultValue: () => ({ get: Effect.succeed(null), report: () => Effect.void }),
}) {}

const decode = Schema.decodeUnknownEffect(IanaTimeZone);
const storedZone = Schema.fromJsonString(IanaTimeZone);
const decodeStored = Schema.decodeUnknownEffect(storedZone);
const encodeStored = Schema.encodeSync(storedZone);
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const filePath = path.join(config.stateDir, "client-time-zone.json");
  const initial = yield* fs.readFileString(filePath).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(null),
    ),
    Effect.mapError((cause) => new ClientTimeZoneError({ operation: "read", cause })),
    Effect.flatMap((raw) =>
      raw === null
        ? Effect.succeed(null)
        : decodeStored(raw).pipe(
            Effect.mapError((cause) => new ClientTimeZoneError({ operation: "decode", cause })),
          ),
    ),
    Effect.catchTags({
      ClientTimeZoneError: (error) => Effect.logWarning(error.message).pipe(Effect.as(null)),
    }),
  );
  const latest = yield* Ref.make<string | null>(initial);
  const writes = yield* Semaphore.make(1);
  const report = Effect.fn("ClientTimeZone.report")(function* (timeZone: string) {
    const zone = yield* decode(timeZone).pipe(
      Effect.mapError((cause) => new ClientTimeZoneError({ operation: "decode", cause })),
    );
    yield* writes.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* Ref.get(latest)) === zone) return;
        // Readers use the latest report even if persistence is slow or unavailable.
        yield* Ref.set(latest, zone);
        yield* writeFileStringAtomically({
          filePath,
          contents: encodeStored(zone) + "\n",
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.catch((cause) =>
            Effect.logWarning(new ClientTimeZoneError({ operation: "persist", cause })),
          ),
        );
      }),
    );
  });
  return ClientTimeZone.of({ get: Ref.get(latest), report });
});
export const layer = Layer.effect(ClientTimeZone, make);
