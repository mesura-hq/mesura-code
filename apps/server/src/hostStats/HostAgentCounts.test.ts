/**
 * Phase 3 fence of the hosts dock plan: acceptance criteria 1 and 2.
 *
 * Entry point: `HostAgentCounts.read`, the query the host stats sampler calls
 * once per sample, through its live layer over an in-memory SQLite database
 * migrated to the V2 orchestration schema.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { makeSqlStatementCounter } from "../../integration/SqlStatementCounter.integration.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as HostAgentCounts from "./HostAgentCounts.ts";

const PROJECT_ID = "project-host-stats";
const CREATED_AT = "2026-09-28T10:00:00.000Z";
const ARCHIVED_AT = "2026-09-28T11:00:00.000Z";
const DELETED_AT = "2026-09-28T11:30:00.000Z";

interface SeededThread {
  readonly id: string;
  /** The status of the thread's latest run, or null for a thread that never ran. */
  readonly runStatus: string | null;
  /** The status of the provider session bound to the thread, or null for none. */
  readonly sessionStatus: string | null;
  readonly archivedAt?: string;
  readonly deletedAt?: string;
}

/**
 * Every run and session status, and live sessions on archived and deleted
 * threads.
 */
const THREADS: ReadonlyArray<SeededThread> = [
  { id: "running-a", runStatus: "running", sessionStatus: "running" },
  { id: "running-b", runStatus: "running", sessionStatus: "running" },
  { id: "waiting", runStatus: "waiting", sessionStatus: "waiting" },
  { id: "starting", runStatus: "starting", sessionStatus: "starting" },
  { id: "ready", runStatus: "completed", sessionStatus: "ready" },
  { id: "queued", runStatus: "queued", sessionStatus: "stopped" },
  { id: "interrupted", runStatus: "interrupted", sessionStatus: "stopped" },
  { id: "failed", runStatus: "failed", sessionStatus: "error" },
  { id: "no-session", runStatus: null, sessionStatus: null },
  {
    id: "archived-running",
    runStatus: "running",
    sessionStatus: "running",
    archivedAt: ARCHIVED_AT,
  },
  { id: "archived-ready", runStatus: "completed", sessionStatus: "ready", archivedAt: ARCHIVED_AT },
  { id: "deleted-running", runStatus: "running", sessionStatus: "running", deletedAt: DELETED_AT },
  {
    id: "deleted-starting",
    runStatus: "starting",
    sessionStatus: "starting",
    deletedAt: DELETED_AT,
  },
];

const seedThreads = (threads: ReadonlyArray<SeededThread>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM orchestration_v2_projection_provider_session_bindings`;
    yield* sql`DELETE FROM orchestration_v2_projection_provider_sessions`;
    yield* sql`DELETE FROM orchestration_v2_projection_runs`;
    yield* sql`DELETE FROM orchestration_v2_projection_threads`;
    for (const thread of threads) {
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, archived_at, deleted_at, payload_json
        )
        VALUES (
          ${thread.id}, ${PROJECT_ID}, ${thread.id}, 'codex', 'full-access', 'default',
          ${CREATED_AT}, ${CREATED_AT}, ${thread.archivedAt ?? null}, ${thread.deletedAt ?? null},
          '{}'
        )
      `;
      if (thread.runStatus !== null) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, status, requested_at, payload_json
          )
          VALUES (
            ${`run-${thread.id}`}, ${thread.id}, 1, 'codex', ${thread.runStatus},
            ${CREATED_AT}, '{}'
          )
        `;
      }
      if (thread.sessionStatus !== null) {
        const sessionId = `session-${thread.id}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_provider_sessions (
            provider_session_id, thread_id, provider, status, updated_at, payload_json
          )
          VALUES (${sessionId}, ${thread.id}, 'codex', ${thread.sessionStatus}, ${CREATED_AT}, '{}')
        `;
        yield* sql`
          INSERT INTO orchestration_v2_projection_provider_session_bindings (
            provider_session_id, thread_id
          )
          VALUES (${sessionId}, ${thread.id})
        `;
      }
    }
  });

const projectionLayer = it.layer(
  HostAgentCounts.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

projectionLayer("HostAgentCounts phase 3 fence", (it) => {
  it.effect(
    "phase 3 AC1: agentsRunning counts live threads with an active run, in one statement",
    () =>
      Effect.gen(function* () {
        const agentCounts = yield* HostAgentCounts.HostAgentCounts;
        yield* seedThreads(THREADS);

        const counter = makeSqlStatementCounter();
        const counts = yield* agentCounts.read.pipe(Effect.withTracer(counter.tracer));
        // running-a, running-b, waiting and starting; archived and deleted threads never count.
        assert.strictEqual(counts.agentsRunning, 4);
        assert.strictEqual(counter.count(), 1);
      }),
  );

  it.effect(
    "phase 3 AC2: agentSessionsOpen counts live sessions that are starting, ready, running or waiting",
    () =>
      Effect.gen(function* () {
        const agentCounts = yield* HostAgentCounts.HostAgentCounts;
        yield* seedThreads(THREADS);

        const counter = makeSqlStatementCounter();
        const counts = yield* agentCounts.read.pipe(Effect.withTracer(counter.tracer));
        assert.deepStrictEqual(counts, { agentsRunning: 4, agentSessionsOpen: 5 });
        assert.strictEqual(counter.count(), 1);
      }),
  );

  it.effect("phase 3 AC2: a session bound to two live threads counts once", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const agentCounts = yield* HostAgentCounts.HostAgentCounts;
      yield* seedThreads([
        { id: "parent", runStatus: "running", sessionStatus: "running" },
        { id: "child", runStatus: null, sessionStatus: null },
      ]);
      yield* sql`
        INSERT INTO orchestration_v2_projection_provider_session_bindings (
          provider_session_id, thread_id
        )
        VALUES ('session-parent', 'child')
      `;
      assert.deepStrictEqual(yield* agentCounts.read, {
        agentsRunning: 1,
        agentSessionsOpen: 1,
      });
    }),
  );

  it.effect("phase 3 AC1 AC2: a host with no sessions counts zero, not null", () =>
    Effect.gen(function* () {
      const agentCounts = yield* HostAgentCounts.HostAgentCounts;
      yield* seedThreads([{ id: "no-session", runStatus: null, sessionStatus: null }]);
      assert.deepStrictEqual(yield* agentCounts.read, {
        agentsRunning: 0,
        agentSessionsOpen: 0,
      });
    }),
  );
});
