import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as ServerConfig from "../config.ts";
import * as ClientTimeZone from "./ClientTimeZone.ts";

const testServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "snooze-zone-rework-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.effect("snooze-zone rework P3-3: identical reports do not write the state again", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const writes = yield* Ref.make(0);
    const store = yield* ClientTimeZone.ClientTimeZone.pipe(
      Effect.provide(ClientTimeZone.layer),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        writeFileString: (...args) =>
          Ref.update(writes, (count) => count + 1).pipe(
            Effect.andThen(fs.writeFileString(...args)),
          ),
      }),
    );
    yield* store.report("America/New_York");
    yield* store.report("America/New_York");
    expect(yield* Ref.get(writes)).toBe(1);
    yield* store.report("Asia/Kathmandu");
    expect(yield* Ref.get(writes)).toBe(2);
  }).pipe(Effect.provide(testServices), Effect.scoped),
);

it.effect("snooze-zone rework P3-4: a failed persistence keeps the report in memory", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const store = yield* ClientTimeZone.ClientTimeZone.pipe(
      Effect.provide(ClientTimeZone.layer),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        writeFileString: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(finish)),
            Effect.andThen(fs.readFileString(config.stateDir + "/missing")),
            Effect.asVoid,
          ),
      }),
    );
    const reporting = yield* store.report("Asia/Kathmandu").pipe(Effect.forkChild);
    yield* Deferred.await(started);
    // Readers use the latest zone even while persistence is blocked.
    expect(yield* store.get).toBe("Asia/Kathmandu");
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(reporting);
    expect(yield* store.get).toBe("Asia/Kathmandu");
    const error = yield* store.report("Mars/Olympus").pipe(Effect.flip);
    expect(error.operation).toBe("decode");
    expect(yield* store.get).toBe("Asia/Kathmandu");
  }).pipe(Effect.provide(testServices), Effect.scoped),
);

it.effect(
  "snooze-zone closure P2-1: a runtime without device reporting needs no store fixture",
  () =>
    Effect.gen(function* () {
      const store = yield* ClientTimeZone.ClientTimeZone;
      expect(yield* store.get).toBeNull();
      yield* store.report("Asia/Kathmandu");
      expect(yield* store.get).toBeNull();
    }),
);
