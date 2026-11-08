import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  type ProjectionRepositoryError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
} from "../persistence/Errors.ts";

/** Agent counts over threads that are not archived or deleted. */
export interface HostAgentCountsReading {
  /** Threads with a run that is starting, running or waiting on the user. */
  readonly agentsRunning: number;
  /** Provider sessions `starting`, `ready`, `running` or `waiting`. */
  readonly agentSessionsOpen: number;
}

/**
 * Counts this server's agents for the hosts dock's per-minute sample, in one
 * statement over the V2 orchestration projection. Fork-owned rather than a
 * method on upstream's `ProjectionStoreV2`, so upstream's test doubles of that
 * store never need it.
 */
export class HostAgentCounts extends Context.Service<
  HostAgentCounts,
  { readonly read: Effect.Effect<HostAgentCountsReading, ProjectionRepositoryError> }
>()("t3/hostStats/HostAgentCounts") {}

const HostAgentCountsRow = Schema.Struct({
  agentsRunning: Schema.Number,
  agentSessionsOpen: Schema.Number,
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A run is active while it is starting, running or waiting, the same set
  // ProjectionStoreV2 treats as live. Sessions bind to threads through the
  // binding table, because one provider session can serve several threads.
  const readCounts = SqlSchema.findOne({
    Request: Schema.Void,
    Result: HostAgentCountsRow,
    execute: () =>
      sql`
        SELECT
          (
            SELECT COUNT(DISTINCT runs.thread_id)
            FROM orchestration_v2_projection_runs runs
            INNER JOIN orchestration_v2_projection_threads threads
              ON threads.thread_id = runs.thread_id
            WHERE runs.status IN ('starting', 'running', 'waiting')
              AND threads.deleted_at IS NULL
              AND threads.archived_at IS NULL
          ) AS "agentsRunning",
          (
            SELECT COUNT(DISTINCT sessions.provider_session_id)
            FROM orchestration_v2_projection_provider_sessions sessions
            INNER JOIN orchestration_v2_projection_provider_session_bindings bindings
              ON bindings.provider_session_id = sessions.provider_session_id
            INNER JOIN orchestration_v2_projection_threads threads
              ON threads.thread_id = bindings.thread_id
            WHERE sessions.status IN ('starting', 'ready', 'running', 'waiting')
              AND threads.deleted_at IS NULL
              AND threads.archived_at IS NULL
          ) AS "agentSessionsOpen"
      `,
  });

  const read = readCounts(undefined).pipe(
    Effect.mapError((cause): ProjectionRepositoryError =>
      Schema.isSchemaError(cause)
        ? toPersistenceDecodeError("HostAgentCounts.read:decodeRow")(cause)
        : toPersistenceSqlError("HostAgentCounts.read:query")(cause),
    ),
    Effect.withSpan("HostAgentCounts.read"),
  );

  return HostAgentCounts.of({ read });
});

export const layer = Layer.effect(HostAgentCounts, make);
