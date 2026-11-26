import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AccountLimitsAccount,
  AccountLimitsSummary,
  ProviderDriverKind,
  ProviderInstanceId,
  type AccountLimitsNamespace,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import { listSubscriptionsFrom, makeAccountLimitsService } from "./AccountLimitsService.ts";
import {
  normalizeAntigravityAccountLimits,
  readAntigravityAccountLimits,
} from "./antigravityAccountLimits.ts";
import { makeSubscriptionRegistry } from "./SubscriptionRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";

const isAccountLimitsAccount = Schema.is(AccountLimitsAccount);
const isAccountLimitsSummary = Schema.is(AccountLimitsSummary);
const DRIVER = ProviderDriverKind.make("antigravity");
const INSTANCE_ID = ProviderInstanceId.make("antigravity");

const signedInLimits: ServerProviderUsageLimits = {
  checkedAt: "2026-11-26T12:00:00.000Z",
  credentialFingerprint: "f00d",
  windows: [
    {
      id: "gemini-5h",
      kind: "session",
      label: "Gemini · 5-hour",
      usedPercent: 12.5,
      resetsAt: "2026-11-26T15:00:00.000Z",
      windowDurationMins: 300,
    },
    {
      id: "3p-weekly",
      kind: "weekly",
      label: "Claude & GPT (shared) · Weekly",
      usedPercent: 40,
      windowDurationMins: 7 * 24 * 60,
    },
    { id: "gemini-quota", kind: "other", label: "Gemini · Reported quota", usedPercent: 3 },
  ],
};

function read(limits: ServerProviderUsageLimits, displayName?: string) {
  return readAntigravityAccountLimits({
    probe: Effect.succeed(limits),
    driver: DRIVER,
    instanceId: INSTANCE_ID,
    displayName,
  });
}

it.layer(NodeServices.layer)("Antigravity account limits", (it) => {
  it.effect("keys a signed-in reading by the Google account, labelled by the instance", () =>
    Effect.gen(function* () {
      const reads = yield* read(signedInLimits, "Antigravity Ultra");
      assert.deepEqual(
        reads.map((entry) => entry.account),
        [{ key: "antigravity:f00d", label: "Antigravity Ultra" }],
      );
      const unnamed = yield* read(signedInLimits);
      assert.equal(unnamed[0]?.account?.label, "Antigravity");
    }),
  );

  it.effect("bounds an overlong instance name so the summary still encodes", () =>
    Effect.gen(function* () {
      const reads = yield* read(signedInLimits, `  ${"x".repeat(300)}  `);
      const label = reads[0]?.account?.label ?? "";
      assert.equal(label.length, 256);
      assert.isTrue(isAccountLimitsAccount(reads[0]?.account));
      const blank = yield* read(signedInLimits, "   ");
      assert.equal(blank[0]?.account?.label, "Antigravity");
    }),
  );

  it.effect("reports no subscription for a profile with no Google sign-in", () =>
    Effect.gen(function* () {
      const reads = yield* read({
        checkedAt: "2026-11-26T12:00:00.000Z",
        windows: [],
        unavailable: { reason: "unsupported", message: "Sign in with Google." },
      });
      assert.deepEqual(reads, []);
    }),
  );

  it.effect("fails a read when the probe could not reach the quota", () =>
    Effect.gen(function* () {
      const error = yield* read({
        checkedAt: "2026-11-26T12:00:00.000Z",
        windows: [],
        unavailable: { reason: "probeFailed", message: "Could not read Antigravity limits." },
      }).pipe(Effect.flip);
      assert.equal(error._tag, "ProviderDriverError");
      assert.equal(error.detail, "Could not read Antigravity limits.");
    }),
  );

  it.effect("normalizes probe windows to the dock's short window names", () =>
    Effect.sync(() => {
      const normalized = normalizeAntigravityAccountLimits(signedInLimits);
      assert.deepEqual(
        normalized?.windows.map((window) => [
          window.label,
          window.usedPercent,
          window.resetsAt,
          window.windowMinutes,
        ]),
        [
          ["Gemini · 5h", 12.5, "2026-11-26T15:00:00.000Z", 300],
          ["Claude & GPT (shared) · 7d", 40, null, 7 * 24 * 60],
          // No window length: the probe's own label stays.
          ["Gemini · Reported quota", 3, null, null],
        ],
      );
      assert.equal(normalizeAntigravityAccountLimits({ windows: "nope" }), null);
    }),
  );

  it.effect("keeps the summary valid when an overlong-named instance fails its first read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "limits-antigravity-fail-" });
      const displayName = "n".repeat(300);
      const instance = {
        instanceId: INSTANCE_ID,
        driverKind: DRIVER,
        displayName,
        enabled: true,
        readAccountLimits: () =>
          read(
            {
              checkedAt: "2026-11-26T12:00:00.000Z",
              windows: [],
              unavailable: { reason: "probeFailed" },
            },
            displayName,
          ),
      } as unknown as ProviderInstance;
      const service = yield* makeAccountLimitsService({
        cachePath: path.join(dir, "cache.json"),
        listInstances: Effect.succeed([instance]),
        refreshInterval: "1 minute",
        freshnessTtl: "5 minutes",
      });
      yield* service.refreshStale;

      const summary = yield* service.readSummary();
      assert.equal(summary.snapshots[0]?.lastAttempt.status, "failed");
      assert.isTrue(isAccountLimitsSummary(summary));
    }).pipe(Effect.scoped),
  );

  it.effect("the account-limits service records an Antigravity instance's reading", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "limits-antigravity-" });
      const instance = {
        instanceId: INSTANCE_ID,
        driverKind: DRIVER,
        enabled: true,
        readAccountLimits: () => read(signedInLimits),
      } as unknown as ProviderInstance;
      const service = yield* makeAccountLimitsService({
        cachePath: path.join(dir, "cache.json"),
        listInstances: Effect.succeed([instance]),
        refreshInterval: "1 minute",
        freshnessTtl: "5 minutes",
      });
      yield* service.refreshStale;

      const [snapshot] = (yield* service.readSummary()).snapshots;
      assert.equal(snapshot?.subscription.key, "antigravity:f00d");
      assert.equal(snapshot?.reader?.driver, "antigravity");
      assert.deepEqual(
        snapshot?.observation?.windows.map((window) => window.label),
        ["Gemini · 5h", "Claude & GPT (shared) · 7d", "Gemini · Reported quota"],
      );
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("paused subscription vendors", (it) => {
  const unusedHttpClient = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 500 }))),
  );

  it.effect("stops polling a paused vendor but keeps its record and credential", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "subs-paused-" });
      const store = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
      const registry = yield* makeSubscriptionRegistry({
        recordPath: path.join(dir, "subscriptions.json"),
        secrets: {
          get: (name) =>
            Ref.get(store).pipe(Effect.map((map) => Option.fromNullishOr(map.get(name)))),
          set: (name, value) => Ref.update(store, (map) => new Map([...map, [name, value]])),
          remove: (name) =>
            Ref.update(store, (map) => new Map([...map].filter(([key]) => key !== name))),
        },
      });
      yield* registry.upsert({ namespace: "zai", label: "GLM Coding Plan", credential: "zai-key" });
      yield* registry.upsert({
        namespace: "opencode-go",
        label: "OpenCode Go",
        credential: "go-key",
      });

      const nothingPaused = yield* listSubscriptionsFrom(
        registry,
        unusedHttpClient,
        new Set<AccountLimitsNamespace>(),
      );
      assert.equal(nothingPaused.length, 2);

      const glmPaused = yield* listSubscriptionsFrom(
        registry,
        unusedHttpClient,
        new Set<AccountLimitsNamespace>(["zai"]),
      );
      assert.deepEqual(
        glmPaused.map((subscription) => subscription.subscription.label),
        ["OpenCode Go"],
      );

      // The shipped defaults pause GLM only, and pausing removes nothing.
      const shipped = yield* listSubscriptionsFrom(registry, unusedHttpClient);
      assert.deepEqual(
        shipped.map((subscription) => subscription.subscription.label),
        ["OpenCode Go"],
      );
      assert.equal((yield* registry.list).length, 2);
      assert.equal((yield* Ref.get(store)).size, 2);
    }).pipe(Effect.scoped),
  );
});
