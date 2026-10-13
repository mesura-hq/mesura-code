// Entry point: WorkloadThreadQuery over real v2 projections in in-memory SQLite.
import { expect, it } from "@effect/vitest";
import { EnvironmentId, NodeId, ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { applyFixtureThread } from "../orchestration-v2/testkit/factoryCardFixtures.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as WorkloadThreadQuery from "./WorkloadThreadQuery.ts";
import { recordFixture, applyProviderFixture } from "./workloadTestkit.ts";

const layer = Layer.mergeAll(ProjectionStore.layer, WorkloadThreadQuery.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-a")),
    }),
  ),
);

it.layer(layer)("F2 persisted workload mapping", (it) => {
  it.effect("F2 native IDs distinguish threads independent of shared process or restart", () =>
    Effect.gen(function* () {
      const a = yield* applyFixtureThread("native-a");
      const b = yield* applyFixtureThread("native-b");
      yield* applyProviderFixture(a, "native-a", "provider-a");
      yield* applyProviderFixture(b, "native-b", "provider-b");
      const query = yield* WorkloadThreadQuery.WorkloadThreadQuery;
      expect(yield* query.resolve(recordFixture())).toEqual({
        state: "assigned",
        threadId: a,
        reason: null,
      });
      expect(
        yield* query.resolve(
          recordFixture({ providerThreadRef: { driver: "codex", nativeId: "native-b" } }),
        ),
      ).toEqual({ state: "assigned", threadId: b, reason: null });
      expect((yield* query.resolve(recordFixture({ environmentId: "other" }))).state).toBe(
        "unassigned",
      );
      expect((yield* query.resolve(recordFixture({ providerInstanceId: "other" }))).state).toBe(
        "unassigned",
      );
    }),
  );
  it.effect("F2 duplicate native references remain ambiguous even on historical rows", () =>
    Effect.gen(function* () {
      const a = yield* applyFixtureThread("duplicate-a");
      const b = yield* applyFixtureThread("duplicate-b");
      yield* applyProviderFixture(a, "native-duplicate", "duplicate-provider-a");
      yield* applyProviderFixture(b, "native-duplicate", "duplicate-provider-b", {
        status: "closed",
      });
      expect(
        (yield* (yield* WorkloadThreadQuery.WorkloadThreadQuery).resolve(
          recordFixture({ providerThreadRef: { driver: "codex", nativeId: "native-duplicate" } }),
        )).reason,
      ).toBe("ambiguous");
    }),
  );
  it.effect("F2 switched current provider reference cannot retain historical attribution", () =>
    Effect.gen(function* () {
      const a = yield* applyFixtureThread("stale");
      yield* applyProviderFixture(a, "native-stale", "old-provider");
      yield* applyProviderFixture(a, "native-new", "new-provider");
      expect(
        (yield* (yield* WorkloadThreadQuery.WorkloadThreadQuery).resolve(
          recordFixture({ providerThreadRef: { driver: "codex", nativeId: "native-stale" } }),
        )).reason,
      ).toBe("stale");
    }),
  );
  it.effect.each([
    "closed",
    "error",
    "archived",
    "weak",
    "subagent",
    "deleted",
    "corrupt",
  ] as const)("F2 persisted resolver rejects ineligible %s identity", (kind) =>
    Effect.gen(function* () {
      const threadId = yield* applyFixtureThread(`ineligible-${kind}`, {
        deleted: kind === "deleted",
      });
      const nativeId = `native-${kind}`;
      yield* applyProviderFixture(
        threadId,
        nativeId,
        `ineligible-provider-${kind}`,
        kind === "weak"
          ? {
              nativeThreadRef: {
                driver: ProviderDriverKind.make("codex"),
                nativeId,
                strength: "weak",
              },
            }
          : kind === "subagent"
            ? { ownerNodeId: NodeId.make("subagent-owner") }
            : ["closed", "error", "archived"].includes(kind)
              ? { status: kind === "closed" ? "closed" : kind === "error" ? "error" : "archived" }
              : {},
      );
      if (kind === "corrupt") {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json = '{}' WHERE provider_thread_id = ${`ineligible-provider-${kind}`}`;
      }
      const result = yield* (yield* WorkloadThreadQuery.WorkloadThreadQuery).resolve(
        recordFixture({ providerThreadRef: { driver: "codex", nativeId } }),
      );
      expect(result.state).toBe("unassigned");
      expect(result.threadId).toBeNull();
    }),
  );
  it.effect("F2 unsupported and missing identity never fall back to legacy app thread", () =>
    Effect.gen(function* () {
      const query = yield* WorkloadThreadQuery.WorkloadThreadQuery;
      expect(
        (yield* query.resolve(
          recordFixture({ thread: "thread:native-a", providerThreadRef: null }),
        )).reason,
      ).toBe("missing-identity");
      expect(
        (yield* query.resolve(
          recordFixture({ providerThreadRef: { driver: "claude", nativeId: "native-a" } }),
        )).reason,
      ).toBe("unsupported-provider");
      expect(
        (yield* query.resolve(
          recordFixture({ providerThreadRef: { driver: "codex", nativeId: "unmapped" } }),
        )).reason,
      ).toBe("unmapped");
    }),
  );
  it.effect("F2 app thread archival alone preserves a strong current native association", () =>
    Effect.gen(function* () {
      const threadId = yield* applyFixtureThread("archived-owner", { archived: true });
      yield* applyProviderFixture(threadId, "native-archived-owner", "provider-archived-owner");
      expect(
        (yield* (yield* WorkloadThreadQuery.WorkloadThreadQuery).resolve(
          recordFixture({
            providerThreadRef: { driver: "codex", nativeId: "native-archived-owner" },
          }),
        )).threadId,
      ).toBe(threadId);
    }),
  );
});
