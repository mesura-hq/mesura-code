/**
 * Phase 3 fence of the hosts dock plan: acceptance criteria 1 and 2.
 *
 * Entry point: `HostAgentCounts.read`, the query the host stats sampler calls
 * once per sample, through its live layer over an in-memory SQLite database.
 * Upstream's live `ProjectionSnapshotQuery` layer runs beside it over the same
 * database, as the reference the running filter must agree with.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeSqlStatementCounter } from "../../integration/SqlStatementCounter.integration.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as HostAgentCounts from "./HostAgentCounts.ts";

const PROJECT_ID = "project-host-stats";
const ARCHIVED_AT = "2026-09-28T11:00:00.000Z";
const DELETED_AT = "2026-09-28T11:30:00.000Z";

interface SeededThread {
  readonly id: string;
  readonly status: string | null;
  readonly activeTurnId?: string;
  readonly archivedAt?: string;
  readonly deletedAt?: string;
}

/**
 * Every session status, a running session without an active turn, and
 * running sessions on archived and deleted threads.
 */
const THREADS: ReadonlyArray<SeededThread> = [
  { id: "running-turn-a", status: "running", activeTurnId: "turn-a" },
  { id: "running-turn-b", status: "running", activeTurnId: "turn-b" },
  { id: "running-no-turn", status: "running" },
  { id: "starting", status: "starting" },
  { id: "ready", status: "ready" },
  { id: "idle", status: "idle" },
  { id: "interrupted", status: "interrupted" },
  { id: "stopped", status: "stopped" },
  { id: "error", status: "error" },
  { id: "no-session", status: null },
  { id: "archived-running", status: "running", activeTurnId: "turn-c", archivedAt: ARCHIVED_AT },
  { id: "archived-ready", status: "ready", archivedAt: ARCHIVED_AT },
  { id: "deleted-running", status: "running", activeTurnId: "turn-d", deletedAt: DELETED_AT },
  { id: "deleted-starting", status: "starting", deletedAt: DELETED_AT },
];

const seedThreads = (threads: ReadonlyArray<SeededThread>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM projection_thread_sessions`;
    yield* sql`DELETE FROM projection_threads`;
    yield* sql`DELETE FROM projection_projects`;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, default_model_selection_json, scripts_json,
        created_at, updated_at, deleted_at
      )
      VALUES (
        ${PROJECT_ID}, 'Host stats', '/tmp/host-stats',
        '{"provider":"codex","model":"gpt-5-codex"}', '[]',
        '2026-09-28T10:00:00.000Z', '2026-09-28T10:00:00.000Z', NULL
      )
    `;
    for (const thread of threads) {
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          branch, worktree_path, latest_turn_id, latest_user_message_at,
          pending_approval_count, pending_user_input_count, has_actionable_proposed_plan,
          created_at, updated_at, archived_at, deleted_at
        )
        VALUES (
          ${thread.id}, ${PROJECT_ID}, ${thread.id}, '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access', 'default', NULL, NULL, NULL, NULL, 0, 0, 0,
          '2026-09-28T10:00:00.000Z', '2026-09-28T10:00:00.000Z',
          ${thread.archivedAt ?? null}, ${thread.deletedAt ?? null}
        )
      `;
      if (thread.status === null) continue;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, provider_session_id, provider_thread_id,
          runtime_mode, active_turn_id, last_error, updated_at
        )
        VALUES (
          ${thread.id}, ${thread.status}, 'codex', ${`session-${thread.id}`},
          ${`provider-thread-${thread.id}`}, 'full-access', ${thread.activeTurnId ?? null},
          NULL, '2026-09-28T10:00:01.000Z'
        )
      `;
    }
  });

const projectionLayer = it.layer(
  Layer.mergeAll(HostAgentCounts.layer, OrchestrationProjectionSnapshotQueryLive).pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

projectionLayer("HostAgentCounts phase 3 fence", (it) => {
  it.effect(
    "phase 3 AC1: agentsRunning counts live threads running an active turn, in one statement",
    () =>
      Effect.gen(function* () {
        const query = yield* ProjectionSnapshotQuery;
        const agentCounts = yield* HostAgentCounts.HostAgentCounts;
        yield* seedThreads(THREADS);

        const counter = makeSqlStatementCounter();
        const counts = yield* agentCounts.read.pipe(Effect.withTracer(counter.tracer));
        assert.strictEqual(counts.agentsRunning, 2);
        assert.strictEqual(counter.count(), 1);

        // The same filter `markRunningProviderSessionsForContinuation` applies to
        // the command read model, so the dock and a self-update agree on "running".
        const { threads } = yield* query.getCommandReadModel();
        const marked = threads.filter(
          (thread) =>
            thread.archivedAt === null &&
            thread.deletedAt === null &&
            thread.session?.status === "running" &&
            thread.session.activeTurnId !== null,
        );
        assert.strictEqual(counts.agentsRunning, marked.length);
      }),
  );

  it.effect(
    "phase 3 AC2: agentSessionsOpen counts live threads whose session is starting, running or ready",
    () =>
      Effect.gen(function* () {
        const agentCounts = yield* HostAgentCounts.HostAgentCounts;
        yield* seedThreads(THREADS);

        const counter = makeSqlStatementCounter();
        const counts = yield* agentCounts.read.pipe(Effect.withTracer(counter.tracer));
        assert.deepStrictEqual(counts, { agentsRunning: 2, agentSessionsOpen: 5 });
        assert.strictEqual(counter.count(), 1);
      }),
  );

  it.effect("phase 3 AC1 AC2: a host with no sessions counts zero, not null", () =>
    Effect.gen(function* () {
      const agentCounts = yield* HostAgentCounts.HostAgentCounts;
      yield* seedThreads([{ id: "no-session", status: null }]);
      assert.deepStrictEqual(yield* agentCounts.read, {
        agentsRunning: 0,
        agentSessionsOpen: 0,
      });
    }),
  );

  it.effect("phase 3 guard: getCounts still counts every project and thread row", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      yield* seedThreads(THREADS);
      assert.deepStrictEqual(yield* query.getCounts(), {
        projectCount: 1,
        threadCount: THREADS.length,
      });
    }),
  );

  it.effect(
    "phase 3 guard: the command read model keeps archived and deleted threads' sessions",
    () =>
      Effect.gen(function* () {
        const query = yield* ProjectionSnapshotQuery;
        yield* seedThreads(THREADS);
        const { threads } = yield* query.getCommandReadModel();
        const sessionStatusById = Object.fromEntries(
          threads.map((thread) => [thread.id, thread.session?.status ?? null]),
        );
        assert.strictEqual(sessionStatusById["running-turn-a"], "running");
        assert.strictEqual(sessionStatusById["no-session"], null);
        assert.strictEqual(threads.length, THREADS.length);
      }),
  );
});
