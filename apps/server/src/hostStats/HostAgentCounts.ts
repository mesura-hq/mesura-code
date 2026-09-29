import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  type ProjectionRepositoryError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
} from "../persistence/Errors.ts";

/** Agent counts over threads that are not archived or deleted. */
export interface HostAgentCountsReading {
  /** Sessions `running` with an active turn: what a self-update would mark for continuation. */
  readonly agentsRunning: number;
  /** Sessions `starting`, `running` or `ready`. */
  readonly agentSessionsOpen: number;
}

/**
 * Counts this server's agents for the hosts dock's per-minute sample, in one
 * statement over the orchestration projection. Fork-owned rather than a method
 * on upstream's `ProjectionSnapshotQuery`, whose full-shape test mocks would
 * each need the method after every merge.
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

  // The running filter mirrors markRunningProviderSessionsForContinuation in
  // serverRuntimeStartup.ts, so the hosts dock and a self-update agree.
  const readCounts = SqlSchema.findOne({
    Request: Schema.Void,
    Result: HostAgentCountsRow,
    execute: () =>
      sql`
        SELECT
          COUNT(
            CASE
              WHEN sessions.status = 'running' AND sessions.active_turn_id IS NOT NULL THEN 1
            END
          ) AS "agentsRunning",
          COUNT(
            CASE WHEN sessions.status IN ('starting', 'running', 'ready') THEN 1 END
          ) AS "agentSessionsOpen"
        FROM projection_thread_sessions sessions
        INNER JOIN projection_threads threads
          ON threads.thread_id = sessions.thread_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
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
