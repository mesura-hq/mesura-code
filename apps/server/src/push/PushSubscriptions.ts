/**
 * Mesura: Web Push devices, one row per endpoint in `mesura_push_subscriptions`. `deliver`
 * deletes the row when the push service answers 404 or 410, because the service forgot the
 * device. Any other failure keeps the row and records `last_failure`: a busy or unreachable
 * service says nothing about the device. In `broadcast`, one device's failure stays its own.
 */
import {
  type PushNotificationPayload,
  PushNotificationError,
  PushPreferences,
  type PushSubscriptionInput,
  type PushSubscriptionStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { PushSender, type PushTarget } from "./PushSender.ts";
import { VapidKeys } from "./vapidKeys.ts";

/** What the Settings test button sends. */
const PUSH_TEST_PAYLOAD: PushNotificationPayload = {
  title: "Mesura Code",
  body: "Push notifications reach this device.",
  tag: "push-test",
  url: "/",
};

const PreferencesJson = Schema.fromJsonString(PushPreferences);
const decodePreferences = Schema.decodeUnknownEffect(PreferencesJson);
const encodePreferences = Schema.encodeEffect(PreferencesJson);

interface SubscriptionRow {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly label: string;
  readonly preferences_json: string;
}

const NOT_SUBSCRIBED: PushSubscriptionStatus = { subscribed: false };

/** Pushes in flight at once during a broadcast. */
const BROADCAST_CONCURRENCY = 4;

/** Storage failures reach the client as one readable error; the cause goes to the log. */
const storageFailure = (action: string) => (cause: unknown) =>
  Effect.logError(`Push subscriptions: could not ${action}`, cause).pipe(
    Effect.andThen(Effect.fail(new PushNotificationError({ detail: `Could not ${action}.` }))),
  );

const targetOf = (row: SubscriptionRow): PushTarget => ({
  endpoint: row.endpoint,
  keys: { p256dh: row.p256dh, auth: row.auth },
});

/** The endpoint is a bearer capability; logs name the device and its push service only. */
const pushServiceHost = (endpoint: string) =>
  URL.canParse(endpoint) ? new URL(endpoint).host : "an unknown push service";

export class PushSubscriptions extends Context.Service<
  PushSubscriptions,
  {
    readonly publicKey: Effect.Effect<{ readonly publicKey: string }>;
    readonly subscribe: (
      input: PushSubscriptionInput,
    ) => Effect.Effect<PushSubscriptionStatus, PushNotificationError>;
    readonly unsubscribe: (
      endpoint: string,
    ) => Effect.Effect<{ readonly removed: boolean }, PushNotificationError>;
    readonly status: (
      endpoint: string,
    ) => Effect.Effect<PushSubscriptionStatus, PushNotificationError>;
    readonly sendTest: (
      endpoint: string,
    ) => Effect.Effect<{ readonly outcome: "delivered" | "gone" }, PushNotificationError>;
    readonly broadcast: (
      kind: keyof PushPreferences,
      payload: PushNotificationPayload,
    ) => Effect.Effect<void, PushNotificationError>;
  }
>()("t3/push/PushSubscriptions") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sender = yield* PushSender;
  const vapid = yield* VapidKeys;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const findRow = (endpoint: string) =>
    sql<SubscriptionRow>`
      SELECT endpoint, p256dh, auth, label, preferences_json
      FROM mesura_push_subscriptions WHERE endpoint = ${endpoint}
    `.pipe(Effect.map((rows) => rows[0]));

  const subscribe = Effect.fn("PushSubscriptions.subscribe")(function* (
    input: PushSubscriptionInput,
  ) {
    const preferencesJson = yield* encodePreferences(input.preferences).pipe(
      Effect.catch(storageFailure("encode the push preferences")),
    );
    const createdAt = yield* nowIso;
    yield* sql`
      INSERT INTO mesura_push_subscriptions
        (endpoint, p256dh, auth, label, preferences_json, created_at)
      VALUES (${input.endpoint}, ${input.keys.p256dh}, ${input.keys.auth}, ${input.label},
        ${preferencesJson}, ${createdAt})
      ON CONFLICT (endpoint) DO UPDATE SET
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        label = excluded.label,
        preferences_json = excluded.preferences_json
    `.pipe(Effect.catch(storageFailure("save the push subscription")));
    return { subscribed: true, preferences: input.preferences } satisfies PushSubscriptionStatus;
  });

  const unsubscribe = Effect.fn("PushSubscriptions.unsubscribe")(function* (endpoint: string) {
    const removed = yield* sql<{ readonly endpoint: string }>`
      DELETE FROM mesura_push_subscriptions WHERE endpoint = ${endpoint} RETURNING endpoint
    `.pipe(Effect.catch(storageFailure("remove the push subscription")));
    return { removed: removed.length > 0 };
  });

  const status = Effect.fn("PushSubscriptions.status")(function* (endpoint: string) {
    const row = yield* findRow(endpoint).pipe(
      Effect.catch(storageFailure("read the push subscription")),
    );
    if (row === undefined) return NOT_SUBSCRIBED;
    const preferences = yield* decodePreferences(row.preferences_json).pipe(
      Effect.catch(storageFailure("read the push preferences")),
    );
    return { subscribed: true, preferences } satisfies PushSubscriptionStatus;
  });

  const deliver = Effect.fn("PushSubscriptions.deliver")(function* (
    row: SubscriptionRow,
    payload: PushNotificationPayload,
  ) {
    const result = yield* sender.send(targetOf(row), payload).pipe(
      Effect.catchTags({
        // Untraced: it runs inside the `PushSubscriptions.deliver` span already.
        PushSendError: Effect.fnUntraced(function* (error) {
          const failedAt = yield* nowIso;
          yield* sql`
            UPDATE mesura_push_subscriptions
            SET last_failure = ${`${failedAt} ${error.detail}`}
            WHERE endpoint = ${row.endpoint}
          `.pipe(Effect.catch(storageFailure("record the push failure")));
          yield* Effect.logWarning(
            `Push to "${row.label}" via ${pushServiceHost(row.endpoint)} failed: ${error.detail}`,
          );
          return yield* new PushNotificationError({ detail: error.detail });
        }),
      }),
    );

    if (result._tag === "gone") {
      yield* sql`DELETE FROM mesura_push_subscriptions WHERE endpoint = ${row.endpoint}`.pipe(
        Effect.catch(storageFailure("remove the expired push subscription")),
      );
      yield* Effect.logInfo(
        `Push subscription "${row.label}" expired at ${pushServiceHost(row.endpoint)}; removed it.`,
      );
      return { outcome: "gone" } as const;
    }

    const deliveredAt = yield* nowIso;
    yield* sql`
      UPDATE mesura_push_subscriptions
      SET last_success_at = ${deliveredAt}, last_failure = NULL
      WHERE endpoint = ${row.endpoint}
    `.pipe(Effect.catch(storageFailure("record the push delivery")));
    return { outcome: "delivered" } as const;
  });

  const sendTest = Effect.fn("PushSubscriptions.sendTest")(function* (endpoint: string) {
    const row = yield* findRow(endpoint).pipe(
      Effect.catch(storageFailure("read the push subscription")),
    );
    if (row === undefined) {
      return yield* new PushNotificationError({
        detail: "This device is not subscribed to push notifications.",
      });
    }
    return yield* deliver(row, PUSH_TEST_PAYLOAD);
  });

  const broadcast = Effect.fn("PushSubscriptions.broadcast")(function* (
    kind: keyof PushPreferences,
    payload: PushNotificationPayload,
  ) {
    const rows = yield* sql<SubscriptionRow>`
      SELECT endpoint, p256dh, auth, label, preferences_json FROM mesura_push_subscriptions
    `.pipe(Effect.catch(storageFailure("read the push subscriptions")));
    const wanted = yield* Effect.filter(rows, (row) =>
      decodePreferences(row.preferences_json).pipe(
        Effect.map((preferences) => preferences[kind]),
        Effect.catch((cause) =>
          Effect.logWarning(
            `Push subscription "${row.label}" has unreadable preferences`,
            cause,
          ).pipe(Effect.as(false)),
        ),
      ),
    );
    // `deliver` already logs and records a failure on its own row.
    yield* Effect.forEach(wanted, (row) => Effect.ignore(deliver(row, payload)), {
      concurrency: BROADCAST_CONCURRENCY,
      discard: true,
    });
  });

  return PushSubscriptions.of({
    publicKey: Effect.succeed({ publicKey: vapid.publicKey }),
    subscribe,
    unsubscribe,
    status,
    sendTest,
    broadcast,
  });
});

export const layer = Layer.effect(PushSubscriptions, make);
