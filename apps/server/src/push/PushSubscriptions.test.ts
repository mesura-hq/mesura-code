/**
 * Push fence, acceptance criteria 2 to 5, through `PushSubscriptions` over the layers
 * `server.ts` wires (real secret store, in-memory SQLite with `MESURA_SCHEMA_STATEMENTS`).
 * The push service is a local `node:http` server. Bodies are decrypted and VAPID verified by
 * `fakePushService.testFixtures.ts`, written from RFC 8291 and RFC 8292, never with `web-push`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { PushNotificationPayload } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  fakePushService,
  makeBrowserSubscription,
  readVapidAuthorization,
  type FakeBrowserSubscription,
} from "./fakePushService.testFixtures.ts";
import * as PushSender from "./PushSender.ts";
import * as PushSubscriptions from "./PushSubscriptions.ts";
import * as VapidKeys from "./vapidKeys.ts";

const makeLayer = (httpClient: Layer.Layer<HttpClient.HttpClient>) =>
  PushSubscriptions.layer.pipe(
    Layer.provideMerge(PushSender.layer),
    Layer.provideMerge(VapidKeys.layer),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(httpClient),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "push-subscriptions-" })),
    ),
  );

/** No push service at all: specs that never send must not reach one. */
const unreachableHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => Effect.die(new Error(`unexpected push request to ${request.url}`))),
);

const subscriptionInput = (
  device: FakeBrowserSubscription,
  label = "Chrome on Android",
  preferences = { approval: true, input: true, failed: true, completed: false },
) => ({ endpoint: device.endpoint, keys: device.keys, label, preferences });

const rows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly endpoint: string;
    readonly p256dh: string;
    readonly auth: string;
    readonly label: string;
    readonly preferences_json: string;
    readonly last_failure: string | null;
  }>`SELECT endpoint, p256dh, auth, label, preferences_json, last_failure
     FROM mesura_push_subscriptions ORDER BY endpoint`;
});

const FCM = "https://fcm.googleapis.com/fcm/send";
const decodePayload = Schema.decodeUnknownSync(PushNotificationPayload);

it.layer(NodeServices.layer)("PushSubscriptions phase 1 fence", (it) => {
  it.effect("push phase 1 AC2: subscribe stores the endpoint, both keys and the preferences", () =>
    Effect.gen(function* () {
      const service = yield* PushSubscriptions.PushSubscriptions;
      const phone = makeBrowserSubscription(`${FCM}/ac2-phone`);
      const preferences = { approval: true, input: false, failed: true, completed: true };

      const status = yield* service.subscribe(subscriptionInput(phone, "Pixel 7", preferences));
      assert.isTrue(status.subscribed);
      assert.deepStrictEqual(status.preferences, preferences);

      const stored = yield* rows;
      assert.strictEqual(stored.length, 1);
      assert.strictEqual(stored[0]!.endpoint, phone.endpoint);
      assert.strictEqual(stored[0]!.p256dh, phone.keys.p256dh);
      assert.strictEqual(stored[0]!.auth, phone.keys.auth);
      assert.strictEqual(stored[0]!.label, "Pixel 7");
      assert.deepStrictEqual(JSON.parse(stored[0]!.preferences_json), preferences);

      const read = yield* service.status(phone.endpoint);
      assert.isTrue(read.subscribed);
      assert.deepStrictEqual(read.preferences, preferences);
    }).pipe(Effect.provide(makeLayer(unreachableHttpClient))),
  );

  it.effect(
    "push phase 1 AC2: a second subscribe with the same endpoint updates that row instead of adding one",
    () =>
      Effect.gen(function* () {
        const service = yield* PushSubscriptions.PushSubscriptions;
        const phone = makeBrowserSubscription(`${FCM}/ac2-resubscribe`);
        const other = makeBrowserSubscription(`${FCM}/ac2-other`);
        yield* service.subscribe(subscriptionInput(other, "Laptop Chrome"));
        yield* service.subscribe(subscriptionInput(phone, "Pixel 7"));

        // The browser rotated its keys and the developer changed a preference.
        const rotated = makeBrowserSubscription(phone.endpoint);
        const preferences = { approval: false, input: true, failed: true, completed: true };
        yield* service.subscribe(subscriptionInput(rotated, "Pixel 7 Pro", preferences));

        const stored = yield* rows;
        assert.strictEqual(stored.length, 2);
        const row = stored.find((entry) => entry.endpoint === phone.endpoint)!;
        assert.strictEqual(row.p256dh, rotated.keys.p256dh);
        assert.strictEqual(row.auth, rotated.keys.auth);
        assert.strictEqual(row.label, "Pixel 7 Pro");
        assert.deepStrictEqual(JSON.parse(row.preferences_json), preferences);
        assert.deepStrictEqual((yield* service.status(phone.endpoint)).preferences, preferences);
      }).pipe(Effect.provide(makeLayer(unreachableHttpClient))),
  );

  it.effect(
    "push phase 1 AC3: unsubscribe removes the row for that endpoint and leaves the others",
    () =>
      Effect.gen(function* () {
        const service = yield* PushSubscriptions.PushSubscriptions;
        const phone = makeBrowserSubscription(`${FCM}/ac3-phone`);
        const tablet = makeBrowserSubscription(`${FCM}/ac3-tablet`);
        yield* service.subscribe(subscriptionInput(phone));
        yield* service.subscribe(subscriptionInput(tablet));

        const result = yield* service.unsubscribe(phone.endpoint);
        assert.isTrue(result.removed);
        assert.deepStrictEqual(
          (yield* rows).map((row) => row.endpoint),
          [tablet.endpoint],
        );
        assert.isFalse((yield* service.status(phone.endpoint)).subscribed);
        assert.isTrue((yield* service.status(tablet.endpoint)).subscribed);
      }).pipe(Effect.provide(makeLayer(unreachableHttpClient))),
  );

  it.effect("push phase 1 AC3: unsubscribe of an unknown endpoint is a no-op", () =>
    Effect.gen(function* () {
      const service = yield* PushSubscriptions.PushSubscriptions;
      const phone = makeBrowserSubscription(`${FCM}/ac3-known`);
      yield* service.subscribe(subscriptionInput(phone));

      const result = yield* service.unsubscribe(`${FCM}/ac3-never-subscribed`);
      assert.isFalse(result.removed);
      assert.deepStrictEqual(
        (yield* rows).map((row) => row.endpoint),
        [phone.endpoint],
      );
      assert.isFalse((yield* service.status(`${FCM}/ac3-never-subscribed`)).subscribed);
    }).pipe(Effect.provide(makeLayer(unreachableHttpClient))),
  );

  it.effect(
    "push phase 1 AC4: sendTest pushes a VAPID-signed aes128gcm body to the calling device only",
    () =>
      Effect.gen(function* () {
        const push = yield* fakePushService();
        yield* Effect.gen(function* () {
          const service = yield* PushSubscriptions.PushSubscriptions;
          const phone = makeBrowserSubscription(`${FCM}/ac4-phone?token=x`);
          const laptop = makeBrowserSubscription(`${FCM}/ac4-laptop`);
          yield* service.subscribe(subscriptionInput(phone));
          yield* service.subscribe(subscriptionInput(laptop, "Laptop Chrome"));
          const { publicKey } = yield* service.publicKey;

          // `web-push` signs the JWT's `exp` with the wall clock, which the TestClock does not reach.
          const sentAtSeconds = Math.floor(
            (yield* TestClock.withLive(Clock.currentTimeMillis)) / 1000,
          );
          const result = yield* service.sendTest(phone.endpoint);
          assert.strictEqual(result.outcome, "delivered");

          assert.strictEqual(push.requests.length, 1, "one request, to the calling device");
          const request = push.requests[0]!;
          assert.strictEqual(request.method, "POST");
          assert.strictEqual(request.path, "/fcm/send/ac4-phone?token=x");
          assert.strictEqual(request.headers["content-encoding"], "aes128gcm");
          assert.strictEqual(request.headers["ttl"], "3600");
          assert.strictEqual(request.headers["urgency"], "high");

          const vapid = readVapidAuthorization(request.headers.authorization);
          assert.isTrue(vapid.signatureValid, "the JWT verifies against k");
          assert.strictEqual(vapid.publicKey, publicKey);
          assert.strictEqual(vapid.header.alg, "ES256");
          assert.strictEqual(vapid.claims.aud, "https://fcm.googleapis.com");
          assert.match(vapid.claims.sub ?? "", /^(mailto:\S+@\S+|https:\/\/\S+)$/);
          // RFC 8292: in the future, and at most 24 hours ahead (one minute of slack for the send).
          assert.isAbove(vapid.claims.exp ?? 0, sentAtSeconds);
          assert.isAtMost(vapid.claims.exp ?? 0, sentAtSeconds + 24 * 60 * 60 + 60);

          const plaintext = new TextDecoder().decode(phone.decrypt(request.body));
          const payload = decodePayload(JSON.parse(plaintext));
          assert.strictEqual(payload.tag, "push-test");
          assert.strictEqual(payload.url, "/");
          assert.isAbove(payload.title.length, 0);
          assert.isAbove(payload.body.length, 0);

          // Encrypted for the phone: the laptop's keys cannot open it.
          assert.throws(() => laptop.decrypt(request.body));
        }).pipe(Effect.provide(makeLayer(push.httpClient)));
      }).pipe(Effect.scoped),
  );

  it.effect(
    "push phase 1 AC4: sendTest to an endpoint that never subscribed fails and sends nothing",
    () =>
      Effect.gen(function* () {
        const service = yield* PushSubscriptions.PushSubscriptions;
        const error = yield* service.sendTest(`${FCM}/ac4-unknown`).pipe(Effect.flip);
        assert.strictEqual(error._tag, "PushNotificationError");
      }).pipe(Effect.provide(makeLayer(unreachableHttpClient))),
  );

  it.effect.each([404, 410])(
    "push phase 1 AC5: a push service answer of %s deletes that subscription only",
    (status) =>
      Effect.gen(function* () {
        const push = yield* fakePushService((path) => (path.includes("gone") ? status : 201));
        yield* Effect.gen(function* () {
          const service = yield* PushSubscriptions.PushSubscriptions;
          const gone = makeBrowserSubscription(`${FCM}/ac5-gone-${status}`);
          const kept = makeBrowserSubscription(`${FCM}/ac5-kept-${status}`);
          yield* service.subscribe(subscriptionInput(gone));
          yield* service.subscribe(subscriptionInput(kept));

          const result = yield* service.sendTest(gone.endpoint);
          assert.strictEqual(result.outcome, "gone");
          assert.strictEqual(push.requests.length, 1);
          assert.deepStrictEqual(
            (yield* rows).map((row) => row.endpoint),
            [kept.endpoint],
          );
          assert.isFalse((yield* service.status(gone.endpoint)).subscribed);
        }).pipe(Effect.provide(makeLayer(push.httpClient)));
      }).pipe(Effect.scoped),
  );

  it.effect.each([400, 413, 429, 500, 503])(
    "push phase 1 AC5: a push service answer of %s keeps the subscription and is logged",
    (status) =>
      Effect.gen(function* () {
        const push = yield* fakePushService(() => status);
        const logs: Array<{ level: string; text: string }> = [];
        const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
          const parts = Array.isArray(message) ? message : [message];
          logs.push({ level: logLevel, text: parts.map(describeLogPart).join(" ") });
        });
        yield* Effect.gen(function* () {
          const service = yield* PushSubscriptions.PushSubscriptions;
          const phone = makeBrowserSubscription(`${FCM}/ac5-failing-${status}`);
          yield* service.subscribe(subscriptionInput(phone, "Pixel 7"));

          const error = yield* service
            .sendTest(phone.endpoint)
            .pipe(
              Effect.flip,
              Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
            );
          assert.strictEqual(error._tag, "PushNotificationError");
          assert.strictEqual(push.requests.length, 1);

          const stored = yield* rows;
          assert.deepStrictEqual(
            stored.map((row) => row.endpoint),
            [phone.endpoint],
          );
          assert.include(stored[0]!.last_failure ?? "", String(status));
          assert.isTrue((yield* service.status(phone.endpoint)).subscribed);
          assertLoggedFailure(logs, String(status));
        }).pipe(Effect.provide(makeLayer(push.httpClient)));
      }).pipe(Effect.scoped),
  );

  it.effect(
    "push phase 1 AC5: a push service that cannot be reached keeps the subscription and is logged",
    () =>
      Effect.gen(function* () {
        const logs: Array<{ level: string; text: string }> = [];
        const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
          const parts = Array.isArray(message) ? message : [message];
          logs.push({ level: logLevel, text: parts.map(describeLogPart).join(" ") });
        });
        const refused = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  description: "connect ECONNREFUSED",
                }),
              }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* PushSubscriptions.PushSubscriptions;
          const phone = makeBrowserSubscription(`${FCM}/ac5-unreachable`);
          yield* service.subscribe(subscriptionInput(phone, "Pixel 7"));

          const error = yield* service
            .sendTest(phone.endpoint)
            .pipe(
              Effect.flip,
              Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
            );
          assert.strictEqual(error._tag, "PushNotificationError");
          assert.deepStrictEqual(
            (yield* rows).map((row) => row.endpoint),
            [phone.endpoint],
          );
          assert.isNotNull((yield* rows)[0]!.last_failure);
          assertLoggedFailure(logs, "ECONNREFUSED");
        }).pipe(Effect.provide(makeLayer(refused)));
      }),
  );

  it.effect(
    "push phase 1 AC1: push.publicKey returns the VAPID public key the sender signs with",
    () =>
      Effect.gen(function* () {
        const service = yield* PushSubscriptions.PushSubscriptions;
        const keys = yield* VapidKeys.VapidKeys;
        assert.deepStrictEqual(yield* service.publicKey, { publicKey: keys.publicKey });
      }).pipe(Effect.provide(makeLayer(unreachableHttpClient))),
  );

  it.effect(
    "push phase 1 rework: a rejection whose body never ends still reports its status and keeps the row",
    () =>
      Effect.gen(function* () {
        const service = yield* PushSubscriptions.PushSubscriptions;
        const phone = makeBrowserSubscription(`${FCM}/rework-stalled-500`);
        yield* service.subscribe(subscriptionInput(phone));

        const { exit, seconds } = yield* settleOnTestClock(service.sendTest(phone.endpoint));
        assert.isTrue(Exit.isFailure(exit), "the send ended");
        // The diagnostic body read gives up after 5 s; the status already decided the outcome.
        assert.isAtMost(seconds, 6);
        const stored = yield* rows;
        assert.deepStrictEqual(
          stored.map((row) => row.endpoint),
          [phone.endpoint],
        );
        assert.include(stored[0]!.last_failure ?? "", "answered 500");
      }).pipe(Effect.provide(makeLayer(stalledBodyHttpClient(500)))),
  );

  it.effect(
    "push phase 1 rework: a 410 whose body never ends deletes the subscription without waiting for the body",
    () =>
      Effect.gen(function* () {
        const service = yield* PushSubscriptions.PushSubscriptions;
        const phone = makeBrowserSubscription(`${FCM}/rework-stalled-410`);
        yield* service.subscribe(subscriptionInput(phone));

        const { exit, seconds } = yield* settleOnTestClock(service.sendTest(phone.endpoint));
        assert.deepStrictEqual(exit, Exit.succeed({ outcome: "gone" as const }));
        assert.isBelow(seconds, 5, "decided by the status alone");
        assert.deepStrictEqual(yield* rows, []);
      }).pipe(Effect.provide(makeLayer(stalledBodyHttpClient(410)))),
  );

  it.effect(
    "push phase 1 rework: a redirect from the push service is a failure, never a delivery",
    () =>
      Effect.gen(function* () {
        const push = yield* fakePushService((path) =>
          path.startsWith("/login") ? 200 : { status: 302, headers: { location: "/login" } },
        );
        yield* Effect.gen(function* () {
          const service = yield* PushSubscriptions.PushSubscriptions;
          const phone = makeBrowserSubscription(`${FCM}/rework-redirect`);
          yield* service.subscribe(subscriptionInput(phone));

          const error = yield* service.sendTest(phone.endpoint).pipe(Effect.flip);
          assert.strictEqual(error._tag, "PushNotificationError");
          assert.deepStrictEqual(
            push.requests.map((request) => request.path),
            ["/fcm/send/rework-redirect"],
            "the redirect was not followed",
          );
          assert.include((yield* rows)[0]!.last_failure ?? "", "302");
        }).pipe(Effect.provide(makeLayer(push.httpClient)));
      }).pipe(Effect.scoped),
  );

  it.effect("push phase 1 rework: no trace span records the subscription endpoint", () =>
    Effect.gen(function* () {
      const push = yield* fakePushService();
      const recorded: Array<{ name: string; attributes: Record<string, unknown> }> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            end(endTime, exit);
            recorded.push({ name: span.name, attributes: Object.fromEntries(span.attributes) });
          };
          return span;
        },
      });
      yield* Effect.gen(function* () {
        const service = yield* PushSubscriptions.PushSubscriptions;
        const phone = makeBrowserSubscription(`${FCM}/SPAN_BEARER_TOKEN`);
        yield* service.subscribe(subscriptionInput(phone));
        yield* service.sendTest(phone.endpoint).pipe(Effect.withTracer(tracer));
      }).pipe(Effect.provide(makeLayer(push.httpClient)));

      assert.strictEqual(push.requests.length, 1);
      assert.notInclude(JSON.stringify(recorded), "SPAN_BEARER_TOKEN");
      const send = recorded.find((span) => span.name === "PushSender.send");
      assert.strictEqual(send?.attributes["push.service.host"], "fcm.googleapis.com");
    }).pipe(Effect.scoped),
  );
});

/** A push service that sends its headers, then holds the body open forever. */
const stalledBodyHttpClient = (status: number) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(new ReadableStream(), { status })),
      ),
    ),
  );

/** Runs `effect` and advances the TestClock a second at a time until it ends, at most 120 s. */
const settleOnTestClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);
    let seconds = 0;
    while (seconds < 120 && fiber.pollUnsafe() === undefined) {
      yield* TestClock.adjust("1 second");
      seconds += 1;
    }
    assert.isDefined(fiber.pollUnsafe(), "the send ended within 120 seconds");
    return { exit: yield* Fiber.await(fiber), seconds };
  });

const describeLogPart = (part: unknown): string =>
  typeof part === "string" ? part : part instanceof Error ? part.message : JSON.stringify(part);

/** A warning or an error names the failure, so the developer can read it in the server log. */
function assertLoggedFailure(
  logs: ReadonlyArray<{ readonly level: string; readonly text: string }>,
  detail: string,
) {
  const failures = logs.filter((entry) => entry.level === "Warn" || entry.level === "Error");
  assert.isTrue(
    failures.some((entry) => entry.text.includes(detail)),
    `a warning or error log mentions ${detail}; saw ${JSON.stringify(logs)}`,
  );
}
