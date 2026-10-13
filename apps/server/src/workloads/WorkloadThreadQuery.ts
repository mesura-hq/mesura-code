import {
  OrchestrationV2AppThreadJson,
  OrchestrationV2ProviderThreadJson,
  type WorkloadAssociation,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { WorkloadRecord } from "./WorkloadRecord.ts";

export class WorkloadThreadQuery extends Context.Service<
  WorkloadThreadQuery,
  {
    readonly resolve: (
      record: Pick<WorkloadRecord, "environmentId" | "providerInstanceId" | "providerThreadRef">,
    ) => Effect.Effect<WorkloadAssociation>;
  }
>()("t3/workloads/WorkloadThreadQuery") {}
const decodeProvider = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2ProviderThreadJson),
);
const decodeThread = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const unassigned = (reason: NonNullable<WorkloadAssociation["reason"]>): WorkloadAssociation => ({
  state: "unassigned",
  threadId: null,
  reason,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const resolve: WorkloadThreadQuery["Service"]["resolve"] = Effect.fn(
    "WorkloadThreadQuery.resolve",
  )(
    function* (record: Parameters<WorkloadThreadQuery["Service"]["resolve"]>[0]) {
      if (
        !record.environmentId ||
        !record.providerInstanceId ||
        !record.providerThreadRef?.nativeId
      )
        return unassigned("missing-identity");
      if (record.environmentId !== (yield* environment.getEnvironmentId))
        return unassigned("environment");
      if (record.providerThreadRef.driver !== "codex") return unassigned("unsupported-provider");
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          // Count historical candidates too. Filtering them first can hide ambiguity.
          const rows = yield* sql<{
            provider_thread_id: string;
            thread_id: string | null;
            owner_node_id: string | null;
            payload_json: string;
          }>`
          SELECT provider_thread_id, thread_id, owner_node_id, payload_json
          FROM orchestration_v2_projection_provider_threads
          WHERE driver = ${record.providerThreadRef!.driver}
            AND provider_instance_id = ${record.providerInstanceId}
            AND json_extract(payload_json, '$.nativeThreadRef.nativeId') = ${record.providerThreadRef!.nativeId}
          LIMIT 2
        `;
          if (rows.length === 0) return unassigned("unmapped");
          if (rows.length !== 1) return unassigned("ambiguous");
          const row = rows[0]!;
          const parsed = decodeProvider(row.payload_json);
          if (Option.isNone(parsed)) return unassigned("stale");
          const provider = parsed.value;
          if (
            provider.id !== row.provider_thread_id ||
            provider.appThreadId !== row.thread_id ||
            provider.ownerNodeId !== row.owner_node_id ||
            provider.driver !== "codex" ||
            provider.providerInstanceId !== record.providerInstanceId ||
            provider.nativeThreadRef?.driver !== "codex" ||
            provider.nativeThreadRef.nativeId !== record.providerThreadRef!.nativeId ||
            provider.nativeThreadRef.strength !== "strong"
          )
            return unassigned("stale");
          if (provider.ownerNodeId !== null) return unassigned("unsupported-subagent");
          if (
            provider.appThreadId === null ||
            !["not_loaded", "idle", "active"].includes(provider.status)
          )
            return unassigned("stale");
          const threads = yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${provider.appThreadId} LIMIT 1`;
          const thread =
            threads[0] === undefined ? Option.none() : decodeThread(threads[0].payload_json);
          if (
            Option.isNone(thread) ||
            thread.value.id !== provider.appThreadId ||
            thread.value.deletedAt !== null ||
            thread.value.activeProviderThreadId !== provider.id
          )
            return unassigned("stale");
          return { state: "assigned" as const, threadId: provider.appThreadId, reason: null };
        }),
      );
    },
    Effect.orElseSucceed(() => unassigned("projection-unavailable")),
  );
  return WorkloadThreadQuery.of({ resolve });
});
export const layer = Layer.effect(WorkloadThreadQuery, make);
