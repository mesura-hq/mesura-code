import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import {
  readOpenCodeGoUsage,
  readZaiUsage,
  SUBSCRIPTION_READ_TIMEOUT,
  SubscriptionTransportError,
  type SubscriptionHttpResponse,
} from "./subscriptionReaders.ts";

const NOW_MS = Date.parse("2026-09-02T03:00:00.000Z");

const GO_BODY =
  '{"usage":{"rolling":{"status":"ok","percent":0,"resetsAt":"2026-09-02T03:41:14.103Z"},' +
  '"weekly":{"status":"ok","percent":40,"resetsAt":"2026-09-07T00:00:00.103Z"},' +
  '"monthly":{"status":"ok","percent":72,"resetsAt":"2026-09-04T15:36:51.103Z"}}}';

const ZAI_BODY =
  '{"code":200,"msg":"Operation successful","success":true,"data":{"level":"lite","limits":[' +
  '{"unit":3,"number":5,"percentage":82,"nextResetTime":1788325042629},' +
  '{"unit":6,"number":1,"percentage":28,"nextResetTime":1788892144998}]}}';

function respondWith(response: SubscriptionHttpResponse) {
  return () => Effect.succeed(response);
}

it.effect("reads the OpenCode Go plan's windows", () =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<{ url: string; headers: Record<string, string> } | null>(null);
    const normalized = yield* readOpenCodeGoUsage({
      credential: "go-key",
      nowMs: NOW_MS,
      get: (request) =>
        Ref.set(seen, request).pipe(
          Effect.as({ status: 200, body: GO_BODY } satisfies SubscriptionHttpResponse),
        ),
    });

    assert.deepEqual(
      normalized.windows.map((window) => window.id),
      ["five_hour", "seven_day", "thirty_day"],
    );
    const request = yield* Ref.get(seen);
    assert.equal(request?.url, "https://opencode.ai/zen/go/v1/usage");
    assert.equal(request?.headers.Authorization, "Bearer go-key");
  }),
);

it.effect("reads the Z.ai plan's windows and tier", () =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<{ url: string; headers: Record<string, string> } | null>(null);
    const normalized = yield* readZaiUsage({
      credential: "zai-key",
      nowMs: NOW_MS,
      get: (request) =>
        Ref.set(seen, request).pipe(
          Effect.as({ status: 200, body: ZAI_BODY } satisfies SubscriptionHttpResponse),
        ),
    });

    assert.equal(normalized.plan, "Lite");
    const request = yield* Ref.get(seen);
    assert.equal(request?.url, "https://api.z.ai/api/monitor/usage/quota/limit");
    // Raw, not Bearer: the endpoint accepts both but documents the raw form.
    assert.equal(request?.headers.Authorization, "zai-key");
  }),
);

it.effect("calls a body it cannot understand our bug, not the vendor's outage", () =>
  Effect.gen(function* () {
    const failure = yield* readOpenCodeGoUsage({
      credential: "go-key",
      nowMs: NOW_MS,
      get: respondWith({ status: 200, body: '{"unexpected":"shape"}' }),
    }).pipe(Effect.flip);
    assert.equal(failure.reason, "unrecognized");
  }),
);

it.effect("calls a rejected credential unauthorized", () =>
  Effect.gen(function* () {
    const failure = yield* readZaiUsage({
      credential: "zai-key",
      nowMs: NOW_MS,
      get: respondWith({ status: 401, body: "nope" }),
    }).pipe(Effect.flip);
    assert.equal(failure.reason, "unauthorized");
  }),
);

it.effect("calls a Z.ai body whose own status says it failed unrecognized", () =>
  Effect.gen(function* () {
    // HTTP 200 carrying code 404 is how this endpoint reports a bad path.
    const failure = yield* readZaiUsage({
      credential: "zai-key",
      nowMs: NOW_MS,
      get: respondWith({ status: 200, body: '{"code":404,"success":false,"data":null}' }),
    }).pipe(Effect.flip);
    assert.equal(failure.reason, "unrecognized");
  }),
);

it.effect("gives up on a hung endpoint rather than holding a poll slot", () =>
  Effect.gen(function* () {
    // The refresh loop runs at concurrency 2. A socket that never answers would
    // wedge the whole account-limit refresh, Claude and Codex rows included.
    const fiber = yield* readOpenCodeGoUsage({
      credential: "go-key",
      nowMs: NOW_MS,
      get: () => Effect.never,
    }).pipe(Effect.flip, Effect.forkScoped);
    yield* TestClock.adjust(SUBSCRIPTION_READ_TIMEOUT);
    const failure = yield* Fiber.join(fiber);
    assert.equal(failure.reason, "unreachable");
  }).pipe(Effect.scoped),
);

it.effect("calls a transport that never answered unreachable", () =>
  Effect.gen(function* () {
    const failure = yield* readZaiUsage({
      credential: "zai-key",
      nowMs: NOW_MS,
      get: () => Effect.fail(new SubscriptionTransportError({ detail: "econnrefused" })),
    }).pipe(Effect.flip);
    assert.equal(failure.reason, "unreachable");
  }),
);

it.effect("calls a throttle the vendor's condition, not our bug", () =>
  Effect.gen(function* () {
    // A 429 falling through to the parse path would tell the developer to
    // update Mesura Code when the right answer is to wait.
    const failure = yield* readOpenCodeGoUsage({
      credential: "go-key",
      nowMs: NOW_MS,
      get: respondWith({ status: 429, body: "slow down" }),
    }).pipe(Effect.flip);
    assert.equal(failure.reason, "unreachable");
  }),
);

it.effect("never puts the credential or the response body in a failure detail", () =>
  Effect.gen(function* () {
    // A body is the likeliest place a vendor echoes a token back at us, and a
    // detail travels to the client.
    const failure = yield* readZaiUsage({
      credential: "super-secret-key",
      nowMs: NOW_MS,
      get: respondWith({ status: 200, body: '{"echoed":"super-secret-key"}' }),
    }).pipe(Effect.flip);
    assert.equal(failure.detail.includes("super-secret-key"), false);
    assert.equal(failure.detail.includes("echoed"), false);
  }),
);
