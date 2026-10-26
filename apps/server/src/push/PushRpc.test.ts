/**
 * Phase 1 fence of phone push notifications: acceptance criterion 6 on the
 * server, which stays authoritative whatever a client checks first.
 *
 * Entry points: `WsRpcGroup`, the group the WebSocket server serves, and
 * `RpcAuthorization.layer`, the middleware every request passes before its
 * handler. A client is an `RpcTest` client holding a grant's scopes.
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
  WsRpcGroup,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/push-rpc-scope";

/** One valid request per push RPC, and a reply its success schema accepts. */
const PUSH_CALLS = [
  { method: "push.publicKey", payload: {}, reply: { publicKey: "BA" } },
  {
    method: "push.subscribe",
    payload: {
      endpoint: ENDPOINT,
      keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA", auth: "tBHItJI5svbpez7KI4CCXg" },
      label: "Chrome on Android",
      // A typed client always sends them; the decoding default is for raw JSON only.
      preferences: { approval: true, input: true, failed: true, completed: false },
    },
    reply: { subscribed: true },
  },
  { method: "push.unsubscribe", payload: { endpoint: ENDPOINT }, reply: { removed: true } },
  { method: "push.status", payload: { endpoint: ENDPOINT }, reply: { subscribed: false } },
  { method: "push.sendTest", payload: { endpoint: ENDPOINT }, reply: { outcome: "delivered" } },
] as const;

// Typed loosely so one loop drives five RPCs whose payload and success types differ.
type AnyGroup = {
  readonly requests: ReadonlyMap<string, unknown>;
  readonly omit: (...tags: ReadonlyArray<string>) => AnyGroup;
  readonly toLayerHandler: (
    tag: string,
    handler: (payload: unknown) => Effect.Effect<unknown>,
  ) => Layer.Layer<never>;
};
const group = WsRpcGroup as unknown as AnyGroup;

const clientFor = (
  method: string,
  reply: unknown,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  calls: { count: number },
) => {
  const only = group.omit(...[...group.requests.keys()].filter((tag) => tag !== method));
  return (
    RpcTest.makeClient(only as never) as unknown as Effect.Effect<
      Record<
        string,
        (payload: unknown) => Effect.Effect<Record<string, unknown>, { readonly _tag: string }>
      >
    >
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        only.toLayerHandler(method, () =>
          Effect.sync(() => {
            calls.count += 1;
            return reply;
          }),
        ),
        RpcAuthorization.layer(scopes),
      ),
    ),
  );
};

describe("PushRpc phase 1 fence: scopes (AC6)", () => {
  it("push phase 1 AC6: every push RPC is served by the WebSocket RPC group", () => {
    const registered = new Set(WsRpcGroup.requests.keys() as Iterable<string>);
    for (const { method } of PUSH_CALLS) {
      assert.isTrue(registered.has(method), `${method} is in WsRpcGroup`);
    }
  });

  it("push phase 1 AC6: the server requires settings:write for every push RPC", () => {
    for (const { method } of PUSH_CALLS) {
      assert.strictEqual(requiredScopeForRpcMethod(method), AuthSettingsWriteScope, method);
    }
  });

  // Guard: true before this phase. A phone paired with the standard grant must reach push.
  it("push phase 1 guard: the standard pairing grant carries settings:write", () => {
    assert.include(AuthStandardClientScopes as ReadonlyArray<string>, AuthSettingsWriteScope);
  });

  it.effect.each(PUSH_CALLS)(
    "push phase 1 AC6: $method refuses a client without settings:write before its handler",
    ({ method, payload, reply }) =>
      Effect.gen(function* () {
        const calls = { count: 0 };
        const refusedClient = yield* clientFor(
          method,
          reply,
          [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
          calls,
        );
        const refusal = yield* refusedClient[method]!(payload).pipe(Effect.flip);
        assert.strictEqual(refusal._tag, "EnvironmentAuthorizationError");
        assert.strictEqual(
          (refusal as unknown as { requiredPermission: string }).requiredPermission,
          AuthSettingsWriteScope,
        );
        assert.strictEqual(calls.count, 0, "the handler never ran");

        const allowedClient = yield* clientFor(method, reply, [AuthSettingsWriteScope], calls);
        yield* allowedClient[method]!(payload);
        assert.strictEqual(calls.count, 1);
      }).pipe(Effect.scoped),
  );
});
