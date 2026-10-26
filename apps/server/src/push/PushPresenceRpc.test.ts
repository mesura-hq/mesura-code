/**
 * Phase 4 fence of phone push notifications: the `push.presence` RPC and
 * acceptance criterion 4's "when its connection closes", across connections.
 *
 * Entry point: `layerWsRpcMesura`, the fork's per-connection handler layer,
 * mounted the way `ws.ts`'s `/ws` route mounts it: the handler layer is given
 * to the protocol setup with `Effect.provide`, and the RPC server is forked
 * into the connection's own scope. With that composition the handler layer's
 * own scope closes as soon as the protocol is set up, not when the socket
 * closes, so an `Effect.addFinalizer` in the handler layer runs at connect.
 * Closing `connection` stands for the socket closing: it ends the RPC server
 * and every request still running on it, as the `/ws` request scope does.
 * That is why `push.presence` is a stream: the end of its call is the close
 * signal, with no seam in `ws.ts`.
 *
 * `ClientPresence.layer` is real and built once at server scope, as
 * `PushSubscriptions` is, so every connection reports into one map.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationReadScope,
  ExecutionEnvironmentDescriptor,
  AuthSettingsWriteScope,
  WS_METHODS,
  WsRpcGroup,
  WsRpcGroupMesura,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";
import * as TestClock from "effect/testing/TestClock";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import { rpcInstrumentationLayer } from "../observability/RpcInstrumentation.ts";
import { layerWsRpcMesura } from "../wsMesura.ts";
import { makeMesuraServerScope, type MesuraServerScope } from "../wsMesura.testkit.ts";
import * as ClientPresence from "./ClientPresence.ts";

const PRESENCE_METHOD = "push.presence";

type PresenceClient = {
  readonly report: (active: boolean) => Effect.Effect<void, { readonly _tag: string }>;
  readonly close: Effect.Effect<void>;
};

/**
 * One WebSocket, composed as `ws.ts` composes it; `close` is the socket
 * closing. `push.presence` is a stream that stays open while its report
 * holds, so `report` does what the client does: it interrupts the previous
 * call, opens a new one in the connection's scope, and returns once the
 * server says it holds the report.
 */
const connectAsWs = (
  serverScope: MesuraServerScope,
  scopes: ReadonlyArray<typeof AuthSettingsWriteScope | typeof AuthOrchestrationReadScope> = [
    AuthSettingsWriteScope,
  ],
) =>
  Effect.gen(function* () {
    const connection = yield* Scope.make();
    const client = yield* RpcTest.makeClient(WsRpcGroupMesura).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerWsRpcMesura.pipe(Layer.provide(Layer.succeedContext(serverScope.context))),
          RpcAuthorization.layer(scopes),
          rpcInstrumentationLayer,
        ),
      ),
      Scope.provide(connection),
    );
    const call = (
      client as unknown as Record<
        string,
        (payload: unknown) => Stream.Stream<unknown, { readonly _tag: string }>
      >
    )[PRESENCE_METHOD];
    assert.isDefined(call, `${PRESENCE_METHOD} is a method of the fork's RPC client`);
    let openCall: Fiber.Fiber<void> | null = null;
    const report = (active: boolean) =>
      Effect.gen(function* () {
        if (openCall !== null) yield* Fiber.interrupt(openCall);
        const recorded = yield* Deferred.make<void, { readonly _tag: string }>();
        openCall = yield* call!({ active }).pipe(
          Stream.runForEach(() => Deferred.succeed(recorded, undefined)),
          Effect.catchCause((cause) => Deferred.failCause(recorded, cause)),
          Effect.asVoid,
          Effect.forkIn(connection),
        );
        yield* Deferred.await(recorded);
      });
    return {
      report,
      close: Scope.close(connection, Exit.void),
    } as PresenceClient;
  });

const withServer = <E>(
  body: (
    serverScope: MesuraServerScope,
    presence: ClientPresence.ClientPresence["Service"],
  ) => Effect.Effect<void, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const presence = Context.get(
      yield* Layer.build(ClientPresence.layer),
      ClientPresence.ClientPresence,
    );
    const serverScope = yield* makeMesuraServerScope(
      Layer.succeed(ClientPresence.ClientPresence, presence),
    );
    yield* body(serverScope, presence);
  }).pipe(Effect.scoped);

describe("push.presence phase 4 fence: the RPC", () => {
  it("push phase 4 contract: push.presence is served by the WebSocket RPC groups", () => {
    assert.strictEqual(
      (WS_METHODS as Record<string, string>).pushPresence,
      PRESENCE_METHOD,
      "WS_METHODS names it",
    );
    assert.isTrue(new Set(WsRpcGroup.requests.keys() as Iterable<string>).has(PRESENCE_METHOD));
    assert.isTrue(
      new Set(WsRpcGroupMesura.requests.keys() as Iterable<string>).has(PRESENCE_METHOD),
    );
  });

  it("push phase 4 contract: push.presence is guarded by settings:write like the other push RPCs", () => {
    assert.strictEqual(requiredScopeForRpcMethod(PRESENCE_METHOD), AuthSettingsWriteScope);
  });

  it.effect("push phase 4 contract: a client without settings:write cannot report presence", () =>
    withServer((serverScope, presence) =>
      Effect.gen(function* () {
        const refused = yield* connectAsWs(serverScope, [AuthOrchestrationReadScope]);
        const refusal = yield* refused.report(true).pipe(Effect.flip);
        assert.strictEqual(refusal._tag, "EnvironmentAuthorizationError");
        assert.isFalse(yield* presence.isAnyClientActive(), "the refused report counted nothing");
      }),
    ),
  );

  it.effect(
    "push phase 4 AC3: a connection's active report over the RPC holds the host active",
    () =>
      withServer((serverScope, presence) =>
        Effect.gen(function* () {
          const desktop = yield* connectAsWs(serverScope);
          yield* desktop.report(true);
          assert.isTrue(yield* presence.isAnyClientActive());
          yield* desktop.report(false);
          assert.isFalse(yield* presence.isAnyClientActive());
        }),
      ),
  );
});

describe("push.presence phase 4 fence (AC4: the connection closes)", () => {
  it.effect("push phase 4 AC4: an active connection stays active after its setup finishes", () =>
    withServer((serverScope, presence) =>
      Effect.gen(function* () {
        const desktop = yield* connectAsWs(serverScope);
        yield* desktop.report(true);
        // A second connection's setup must not end the first one's state.
        yield* connectAsWs(serverScope);
        assert.isTrue(yield* presence.isAnyClientActive());
      }),
    ),
  );

  it.effect("push phase 4 AC4: closing an active connection ends its active state", () =>
    withServer((serverScope, presence) =>
      Effect.gen(function* () {
        const desktop = yield* connectAsWs(serverScope);
        yield* desktop.report(true);
        assert.isTrue(yield* presence.isAnyClientActive());
        yield* desktop.close;
        assert.isFalse(yield* presence.isAnyClientActive());
      }),
    ),
  );

  it.effect(
    "push phase 4 AC4: closing one active connection leaves the other connection's state",
    () =>
      withServer((serverScope, presence) =>
        Effect.gen(function* () {
          const desktop = yield* connectAsWs(serverScope);
          const browserTab = yield* connectAsWs(serverScope, [
            AuthSettingsWriteScope,
            AuthOrchestrationReadScope,
          ]);
          yield* desktop.report(true);
          yield* browserTab.report(true);
          yield* desktop.close;
          assert.isTrue(yield* presence.isAnyClientActive(), "the browser tab is still active");
          yield* browserTab.report(false);
          assert.isFalse(yield* presence.isAnyClientActive());
        }),
      ),
  );

  it.effect(
    "push phase 4 AC4: each connection reports under its own identity, not the shared client id 0",
    () =>
      withServer((serverScope, presence) =>
        Effect.gen(function* () {
          // Every WebSocket's RPC protocol numbers its client 0 (wsMesura.ts).
          const desktop = yield* connectAsWs(serverScope);
          const phone = yield* connectAsWs(serverScope);
          yield* desktop.report(true);
          yield* phone.report(false);
          assert.isTrue(yield* presence.isAnyClientActive(), "the phone did not overwrite it");
          yield* phone.close;
          assert.isTrue(yield* presence.isAnyClientActive(), "closing the phone kept the desktop");
        }),
      ),
  );
});

describe("push.presence phase 4 fence (steady activity)", () => {
  it.effect(
    "push phase 4 AC4: a client that keeps re-reporting active stays active for minutes, then lapses",
    () =>
      withServer((serverScope, presence) =>
        Effect.gen(function* () {
          const desktop = yield* connectAsWs(serverScope);
          yield* desktop.report(true);
          // The client re-reports while input keeps coming, at most every 30 seconds.
          for (let minute = 1; minute <= 6; minute += 1) {
            yield* TestClock.adjust("60 seconds");
            assert.isTrue(yield* presence.isAnyClientActive(), `minute ${minute}`);
            yield* desktop.report(true);
          }
          yield* TestClock.adjust("2 minutes");
          assert.isFalse(yield* presence.isAnyClientActive(), "two minutes after the last report");
        }),
      ),
  );
});

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

// A client sends `push.presence` only to a server that advertises it
// (`PresenceReporter`), so an older server is never sent a method it lacks.
describe("push.presence phase 4 regression: the pushPresence capability", () => {
  it.effect("push phase 4 regression: this server advertises pushPresence", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-push-presence-capability-",
      });
      const descriptor = yield* Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
        return yield* serverEnvironment.getDescriptor;
      }).pipe(
        Effect.provide(
          ServerEnvironment.layer.pipe(
            Layer.provide(ServerSecretStore.layer),
            Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
          ),
        ),
      );
      assert.strictEqual(descriptor.capabilities.pushPresence, true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("push phase 4 guard: a descriptor from a server without pushPresence still decodes", () => {
    const decoded = decodeDescriptor({
      environmentId: "environment-1",
      label: "older-host",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.0.42",
      capabilities: { repositoryIdentity: true },
    });
    assert.isUndefined(decoded.capabilities.pushPresence);
  });
});
