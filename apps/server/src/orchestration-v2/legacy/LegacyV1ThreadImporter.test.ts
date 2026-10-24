// Entry point: LegacyV1ThreadImporter.reconcileShells, awaited by server startup
// before FactoryRunTracker.reattachRecordedRuns. Only synthetic v1 rows are used.
import { assert, it } from "@effect/vitest";
import {
  EventId,
  ThreadId,
  factoryPlanCardId,
  factoryRunActivityId,
  factoryReportActivityId,
  ComposerContextId,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { listLinkedPullRequestThreads } from "../../pullRequest/linkedThreads.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as LegacyV1ThreadImporter from "./LegacyV1ThreadImporter.ts";
import * as ProjectionMaintenance from "../ProjectionMaintenance.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as FactoryCardQuery from "../FactoryCardQuery.ts";
import { fixtureRunPayload } from "../testkit/factoryCardFixtures.ts";

const layerDatabase = SqlitePersistence.layerMemory;
const layerEventStoreProvided = EventStore.layer.pipe(Layer.provideMerge(layerDatabase));
const layerProjectionStoreProvided = ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase));
const layerStoresProvided = Layer.mergeAll(
  layerDatabase,
  layerEventStoreProvided,
  layerProjectionStoreProvided,
);
const layerEventSinkProvided = EventSink.layer.pipe(Layer.provide(layerStoresProvided));
const layerImporterProvided = LegacyV1ThreadImporter.layer.pipe(
  Layer.provide(Layer.mergeAll(layerStoresProvided, layerEventSinkProvided)),
);
const layerProjectionMaintenanceProvided = ProjectionMaintenance.layer.pipe(
  Layer.provide(layerStoresProvided),
);
const layerTest = Layer.mergeAll(
  layerStoresProvided,
  layerEventSinkProvided,
  layerImporterProvided,
  layerProjectionMaintenanceProvided,
  FactoryCardQuery.layer.pipe(Layer.provide(layerDatabase)),
);

const publicLayerThreadIds = [
  ThreadId.make("thread:factory-public-direct"),
  ThreadId.make("thread:factory-public-background"),
] as const;
const layerPublicFixture = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const threadId of publicLayerThreadIds) {
      yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        interaction_mode, created_at, updated_at
      ) VALUES (${threadId}, 'project:factory-public', 'Public importer',
        '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
        '2026-01-01T00:00:00.000Z', '2026-01-05T00:00:00.000Z')
    `;
      for (const [suffix, role, day] of [
        ["first", "user", 1],
        ["answer", "assistant", 3],
        ["latest", "user", 5],
      ] as const) {
        const at = `2026-01-0${day}T00:00:00.000Z`;
        yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (${`${threadId}:${suffix}`}, ${threadId}, ${role}, ${suffix}, 0, ${at}, ${at})
      `;
      }
      yield* sql`
      INSERT INTO projection_thread_activities (
        activity_id, thread_id, tone, kind, summary, payload_json, created_at, sequence
      ) VALUES (${factoryRunActivityId(threadId, "unfinished")}, ${threadId}, 'info',
        'factory.run', 'Factory', ${JSON.stringify(fixtureRunPayload(threadId, "unfinished", "running"))},
        '2026-01-02T00:00:00.000Z', 1)
    `;
    }
  }),
).pipe(Layer.provide(layerDatabase));

// Export only the public services. SqlClient and EventSink are construction dependencies.
const layerPublicImporterTest = Layer.mergeAll(
  layerImporterProvided,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  FactoryCardQuery.layer.pipe(Layer.provide(layerDatabase)),
  layerProjectionMaintenanceProvided,
).pipe(Layer.provide(layerPublicFixture));

it.layer(layerPublicImporterTest)("Mesura importer public service boundary", (it) => {
  it.effect(
    "Mesura gate repair imports, rebuilds and hydrates through the public layer without caller persistence services",
    () =>
      Effect.gen(function* () {
        assert(Option.isNone(yield* Effect.serviceOption(SqlClient.SqlClient)));
        assert(Option.isNone(yield* Effect.serviceOption(EventSink.EventSinkV2)));
        const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const cards = yield* FactoryCardQuery.FactoryCardQuery;
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        assert.equal(yield* importer.pendingThreadCount, 2);
        yield* importer.reconcileShells;
        for (const threadId of publicLayerThreadIds) {
          assert.lengthOf((yield* projections.getThreadProjection(threadId)).messages, 1);
        }
        assert.lengthOf(yield* cards.listByKind("run"), 2);
        yield* maintenance.rebuild;
        yield* importer.reconcileShells;
        assert.deepStrictEqual(yield* importer.ensureTranscript(publicLayerThreadIds[0]), {
          importedThreadCount: 1,
          importedMessageCount: 2,
        });
        assert.deepStrictEqual(yield* importer.importPendingTranscripts, {
          importedThreadCount: 1,
          importedMessageCount: 2,
        });
        assert.equal(yield* importer.pendingThreadCount, 0);
        yield* maintenance.rebuild;
        for (const threadId of publicLayerThreadIds) {
          const projection = yield* projections.getThreadProjection(threadId);
          assert.lengthOf(projection.runs, 0);
          assert.deepStrictEqual(
            projection.thread.updatedAt,
            DateTime.makeUnsafe("2026-01-05T00:00:00.000Z"),
          );
          assert.deepStrictEqual(
            projection.turnItems.map((item) => [item.id, item.ordinal]),
            [
              [`migration:v1:turn-item:${threadId}:first`, 1],
              [factoryRunActivityId(threadId, "unfinished"), 2],
              [`migration:v1:turn-item:${threadId}:answer`, 3],
              [`migration:v1:turn-item:${threadId}:latest`, 4],
            ],
          );
        }
      }),
  );
});

const seedPendingTranscripts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
  const threadIds = [ThreadId.make("thread:first"), ThreadId.make("thread:later")];
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at
    ) VALUES (
      'project:background', 'Legacy project', '/tmp/legacy-background', '[]',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    )
  `;
  for (const threadId of threadIds) {
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        interaction_mode, created_at, updated_at
      ) VALUES (
        ${threadId}, 'project:background', 'Legacy thread',
        '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      )
    `;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, is_streaming, created_at, updated_at
      ) VALUES
        (${`${threadId}:old`}, ${threadId}, 'user', 'Old question', 0,
          '2026-01-01T01:00:00.000Z', '2026-01-01T01:00:00.000Z'),
        (${`${threadId}:latest`}, ${threadId}, 'user', 'Latest question', 0,
          '2026-01-02T01:00:00.000Z', '2026-01-02T01:00:00.000Z')
    `;
  }
  yield* importer.reconcileShells;
});

it.effect(
  "keeps hydrating later transcripts after a defect and leaves the failed thread pending",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* seedPendingTranscripts;
      yield* sql`
        UPDATE projection_thread_messages SET created_at = '0000-not-a-date'
        WHERE message_id = 'thread:first:old'
      `;

      yield* importer.importPendingTranscripts;

      const later = yield* projections.getThreadProjection(ThreadId.make("thread:later"));
      assert.deepStrictEqual(
        later.messages.map((message) => message.text),
        ["Old question", "Latest question"],
      );
      assert.deepStrictEqual(
        yield* sql`
          SELECT thread_id, transcript_imported_at, last_error FROM orchestration_v2_legacy_imports
          WHERE transcript_imported_at IS NULL OR last_error IS NOT NULL
        `,
        [
          {
            thread_id: "thread:first",
            transcript_imported_at: null,
            last_error: "Transcript hydration failed; retry on next open.",
          },
        ],
      );
    }).pipe(Effect.provide(layerTest)),
);

// regression: #15920 one bad legacy message stopped the server from starting
it.effect("propagates interruption from transcript reads and retry-marker writes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    yield* seedPendingTranscripts;
    const interrupted = [];
    for (const phase of ["transcript", "retry-marker"]) {
      const exit = yield* importer.importPendingTranscripts.pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) => {
          const [query] = statement.compile();
          const readingTranscript = query.includes("FROM projection_thread_messages");
          const writingRetryMarker = query.includes("SET last_error =");
          if (phase === "retry-marker" && readingTranscript) {
            return Effect.die("transcript read failed");
          }
          if (phase === "transcript" ? readingTranscript : writingRetryMarker) {
            return Effect.interrupt;
          }
          return Effect.succeed(statement);
        }),
        Effect.exit,
      );
      interrupted.push(Exit.hasInterrupts(exit));
    }
    assert.deepStrictEqual(interrupted, [true, true]);
    assert.deepStrictEqual(
      yield* sql`
        SELECT thread_id FROM orchestration_v2_legacy_imports
        WHERE transcript_imported_at IS NOT NULL OR last_error IS NOT NULL
      `,
      [],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.layer(layerTest)("LegacyV1ThreadImporter", (it) => {
  it.effect("imports lightweight shells, hydrates transcripts, and remains idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:legacy-import");

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          'project:legacy-import',
          'Legacy project',
          '/tmp/legacy-project',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          unsettled_at,
          snoozed_until,
          snoozed_at,
          pinned_at,
          pin_order_key,
          linked_pull_request_json,
          deleted_at
        ) VALUES (
          ${threadId},
          'project:legacy-import',
          'Migrated conversation',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access',
          'default',
          ' main ',
          ' /tmp/legacy-project ',
          NULL,
          '2026-01-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          NULL,
          NULL,
          NULL,
          '2026-01-03T12:00:00.000Z',
          '2026-02-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          'm',
          '{"projectId":"project:legacy-import","repository":"pingdotgg/t3code","number":9000,"url":"https://github.com/pingdotgg/t3code/pull/9000"}',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        ) VALUES
          (
            'message:legacy:1',
            ${threadId},
            NULL,
            'user',
            'First question',
            '[]',
            0,
            '2026-01-01T01:00:00.000Z',
            '2026-01-01T01:00:00.000Z'
          ),
          (
            'message:legacy:2',
            ${threadId},
            NULL,
            'assistant',
            'First answer',
            '[]',
            0,
            '2026-01-02T01:00:00.000Z',
            '2026-01-02T01:00:00.000Z'
          ),
          (
            'message:legacy:3',
            ${threadId},
            NULL,
            'user',
            'Follow-up question',
            '[]',
            0,
            '2026-01-03T01:00:00.000Z',
            '2026-01-03T01:00:00.000Z'
          ),
          (
            'message:legacy:4',
            ${threadId},
            NULL,
            'assistant',
            'Partial answer',
            '[]',
            1,
            '2026-01-04T01:00:00.000Z',
            '2026-01-04T01:00:00.000Z'
        )
      `;

      const validContext = {
        version: 1,
        records: [
          {
            version: 1,
            contextId: ComposerContextId.make("ctx_1"),
            kind: "skill",
            label: "$test",
            name: "test",
          },
        ],
      } satisfies OrchestrationMessageContext;
      yield* sql`
        UPDATE projection_thread_messages
        SET context_json = CASE message_id
          WHEN 'message:legacy:2' THEN '{broken-json'
          WHEN 'message:legacy:3' THEN '{"version":2,"records":[]}'
          ELSE ${JSON.stringify(validContext)}
        END
        WHERE thread_id = ${threadId}
      `;
      const sourceMessages = yield* sql`
        SELECT * FROM projection_thread_messages WHERE thread_id = ${threadId} ORDER BY message_id
      `;

      yield* sql`
        INSERT INTO projection_thread_pull_requests (
          thread_id, host, repository, number, url, source, linked_at, snapshot_json
        ) VALUES
          (${threadId}, 'github.com', 'pingdotgg/t3code', 9002,
            'https://github.com/pingdotgg/t3code/pull/9002', 'created',
            '2026-01-03T00:00:00.000Z',
            '{"state":"open","title":"Second PR","headBranch":"feature-two","baseBranch":"main","isDraft":false,"updatedAt":"2026-01-03T00:00:00.000Z","syncedAt":"2026-01-03T00:00:00.000Z"}'),
          (${threadId}, 'github.com', 'pingdotgg/t3code', 9003,
            'https://github.com/pingdotgg/t3code/pull/9003', 'manual',
            '2026-01-04T00:00:00.000Z', NULL)
      `;

      assert.equal(yield* importer.pendingThreadCount, 1);
      const shellImport = yield* importer.reconcileShells;
      assert.equal(yield* importer.pendingThreadCount, 1);
      assert.deepStrictEqual(shellImport, {
        importedThreadCount: 1,
        importedMessageCount: 2,
      });
      const shellEventCount = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
      `;
      assert.equal(shellEventCount[0]?.count, 6);

      assert.isTrue((yield* maintenance.verify).valid);
      const shellProjection = yield* projections.getThreadProjection(threadId);
      assert.equal(shellProjection.thread.historyOrigin, "v1_import");
      assert.equal(shellProjection.thread.branch, "main");
      assert.equal(shellProjection.thread.worktreePath, "/tmp/legacy-project");
      assert.deepEqual(
        shellProjection.thread.pinnedAt,
        DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      );
      assert.equal(shellProjection.thread.pinOrderKey, "m");
      assert.deepEqual(
        shellProjection.thread.snoozedUntil,
        DateTime.makeUnsafe("2026-02-01T00:00:00.000Z"),
      );
      assert.deepEqual(
        shellProjection.thread.unsettledAt,
        DateTime.makeUnsafe("2026-01-03T12:00:00.000Z"),
      );
      assert.equal(shellProjection.thread.linkedPullRequest?.number, 9000);
      assert.deepStrictEqual(
        (shellProjection.thread.pullRequests ?? []).map((link) => link.number),
        [9002, 9003, 9000],
      );
      assert.equal(shellProjection.thread.pullRequests?.[0]?.snapshot?.title, "Second PR");
      assert.deepStrictEqual(
        (yield* listLinkedPullRequestThreads({
          host: "github.com",
          repository: "pingdotgg/t3code",
          number: 9002,
        })).threads.map((thread) => thread.id),
        [threadId],
      );
      const shellSnapshot = yield* projections.getShellSnapshot();
      assert.equal(
        shellSnapshot.threads.find((thread) => thread.id === threadId)?.historyOrigin,
        "v1_import",
      );
      assert.deepStrictEqual(
        shellProjection.messages.map((message) => message.id),
        ["message:legacy:3", "message:legacy:4"],
      );
      assert.deepStrictEqual(
        shellProjection.messages.map((message) => [message.text, message.context]),
        [
          ["Follow-up question", undefined],
          ["Partial answer", validContext],
        ],
      );

      const renamedAt = DateTime.makeUnsafe("2026-01-05T00:00:00.000Z");
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:legacy-import:metadata-after-shell"),
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId: shellProjection.thread.providerInstanceId,
            occurredAt: renamedAt,
            payload: {
              ...shellProjection.thread,
              title: "Renamed after shell import",
              runtimeMode: "approval-required",
              interactionMode: "plan",
              archivedAt: renamedAt,
              settledOverride: "settled",
              settledAt: renamedAt,
              updatedAt: renamedAt,
            },
          },
        ],
      });

      const transcriptImport = yield* importer.importPendingTranscripts;
      assert.equal(yield* importer.pendingThreadCount, 0);
      assert.deepStrictEqual(transcriptImport, {
        importedThreadCount: 1,
        importedMessageCount: 2,
      });
      const projection = yield* projections.getThreadProjection(threadId);
      assert.equal(projection.thread.title, "Renamed after shell import");
      assert.isNull(projection.thread.lastVisitedAt);
      assert.equal(projection.thread.runtimeMode, "approval-required");
      assert.equal(projection.thread.interactionMode, "plan");
      assert.deepEqual(projection.thread.archivedAt, renamedAt);
      assert.equal(projection.thread.settledOverride, "settled");
      assert.deepEqual(projection.thread.settledAt, renamedAt);
      assert.deepStrictEqual(
        projection.messages.map((message) => message.id),
        ["message:legacy:1", "message:legacy:2", "message:legacy:3", "message:legacy:4"],
      );
      const expectedMessages = [
        ["First question", validContext],
        ["First answer", undefined],
        ["Follow-up question", undefined],
        ["Partial answer", validContext],
      ];
      assert.deepStrictEqual(
        projection.messages.map((message) => [message.text, message.context]),
        expectedMessages,
      );
      assert.deepStrictEqual(
        yield* sql`
          SELECT * FROM projection_thread_messages WHERE thread_id = ${threadId} ORDER BY message_id
        `,
        sourceMessages,
      );
      assert.deepStrictEqual(
        projection.turnItems
          .filter(
            (
              item,
            ): item is Extract<
              (typeof projection.turnItems)[number],
              { readonly type: "user_message" | "assistant_message" }
            > => item.type === "user_message" || item.type === "assistant_message",
          )
          .map((item) => [item.messageId, item.ordinal, item.status]),
        [
          ["message:legacy:1", 1, "completed"],
          ["message:legacy:2", 2, "completed"],
          ["message:legacy:3", 3, "completed"],
          ["message:legacy:4", 4, "interrupted"],
        ],
      );

      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:legacy-import:explicit-unpin"),
            type: "thread.unpinned",
            threadId,
            providerInstanceId: projection.thread.providerInstanceId,
            occurredAt: renamedAt,
            payload: { ...projection.thread, pinnedAt: null, pinOrderKey: null },
          },
        ],
      });
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_remove(
          payload_json,
          '$.snoozedUntil',
          '$.snoozedAt',
          '$.unsettledAt',
          '$.linkedPullRequest',
          '$.pullRequests'
        )
        WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 1,
        importedMessageCount: 0,
      });
      const repaired = yield* projections.getThreadProjection(threadId);
      assert.isNull(repaired.thread.pinnedAt);
      assert.isNull(repaired.thread.pinOrderKey);
      assert.deepEqual(
        repaired.thread.snoozedUntil,
        DateTime.makeUnsafe("2026-02-01T00:00:00.000Z"),
      );
      assert.deepEqual(
        repaired.thread.unsettledAt,
        DateTime.makeUnsafe("2026-01-03T12:00:00.000Z"),
      );
      assert.equal(repaired.thread.linkedPullRequest?.number, 9000);
      assert.deepStrictEqual(
        (repaired.thread.pullRequests ?? []).map((link) => link.number),
        [9002, 9003, 9000],
      );
      assert.equal(repaired.thread.pullRequests?.[0]?.snapshot?.title, "Second PR");
      const eventCountBeforeRetry = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
      `;
      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 0,
        importedMessageCount: 0,
      });
      assert.deepStrictEqual(yield* importer.ensureTranscript(threadId), {
        importedThreadCount: 0,
        importedMessageCount: 0,
      });
      const eventCountAfterRetry = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
      `;
      assert.equal(eventCountAfterRetry[0]?.count, eventCountBeforeRetry[0]?.count);
    }),
  );

  it.effect("repairs newly added metadata after an earlier metadata repair", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:legacy-metadata-upgrade");
      const previousRepairId = EventId.make(`migration:v1:thread:${threadId}:metadata-repair`);

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (
          'project:legacy-metadata-upgrade',
          'Legacy project',
          '/tmp/legacy-metadata-upgrade',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, pinned_at, pin_order_key,
          linked_pull_request_json, branch_pull_request_json, active_order_key
        ) VALUES (
          ${threadId},
          'project:legacy-metadata-upgrade',
          'Original v1 title',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access',
          'default',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          'm',
          '{"projectId":"project:legacy-metadata-upgrade","repository":"pingdotgg/t3code","number":9000,"url":"https://github.com/pingdotgg/t3code/pull/9000"}',
          '{"projectId":"project:legacy-metadata-upgrade","repository":"pingdotgg/t3code","number":9001,"url":"https://github.com/pingdotgg/t3code/pull/9001"}',
          'az'
        )
      `;
      yield* importer.reconcileShells;
      yield* maintenance.rebuild;
      const shellProjection = yield* projections.getThreadProjection(threadId);
      assert.deepStrictEqual(
        (shellProjection.thread.pullRequests ?? []).map((link) => link.number),
        [9000],
      );
      const previousRepairThread = {
        ...shellProjection.thread,
        title: "Renamed in v2",
        pinnedAt: null,
        pinOrderKey: null,
        linkedPullRequest: null,
        pullRequests: [],
      };
      delete previousRepairThread.branchPullRequest;
      delete previousRepairThread.activeOrderKey;
      yield* eventSink.write({
        events: [
          {
            id: previousRepairId,
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId: previousRepairThread.providerInstanceId,
            occurredAt: DateTime.makeUnsafe("2026-01-03T00:00:00.000Z"),
            payload: previousRepairThread,
          },
        ],
      });

      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 1,
        importedMessageCount: 0,
      });
      const repaired = yield* projections.getThreadProjection(threadId);
      assert.equal(repaired.thread.title, "Renamed in v2");
      assert.isNull(repaired.thread.pinnedAt);
      assert.isNull(repaired.thread.pinOrderKey);
      assert.isNull(repaired.thread.linkedPullRequest);
      assert.deepStrictEqual(repaired.thread.pullRequests, []);
      assert.equal(repaired.thread.branchPullRequest?.number, 9001);
      assert.equal(repaired.thread.activeOrderKey, "az");

      const eventsBeforeRetry = yield* sql<{ readonly event_id: string }>`
        SELECT event_id
        FROM orchestration_events
        WHERE application_event_version = 2 AND stream_id = ${threadId}
        ORDER BY sequence
      `;
      assert.equal(eventsBeforeRetry.length, 4);
      assert.isTrue(eventsBeforeRetry.some((event) => event.event_id === previousRepairId));
      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 0,
        importedMessageCount: 0,
      });

      assert.isTrue((yield* maintenance.rebuild).valid);
      const replayed = yield* projections.getThreadProjection(threadId);
      assert.deepStrictEqual(replayed.thread, repaired.thread);
      assert.deepStrictEqual(
        yield* Effect.gen(function* () {
          const restartedImporter = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
          return yield* restartedImporter.reconcileShells;
        }).pipe(Effect.provide(LegacyV1ThreadImporter.layer)),
        { importedThreadCount: 0, importedMessageCount: 0 },
      );
      const eventsAfterRestart = yield* sql<{ readonly event_id: string }>`
        SELECT event_id
        FROM orchestration_events
        WHERE application_event_version = 2 AND stream_id = ${threadId}
        ORDER BY sequence
      `;
      assert.deepStrictEqual(eventsAfterRestart, eventsBeforeRetry);
    }),
  );
});

for (const [previouslyHydrated, rebuildBeforeHydration] of [
  [false, false],
  [true, false],
  [false, true],
] as const) {
  it.layer(layerTest)(
    `Mesura historical Factory migration ${rebuildBeforeHydration ? "rebuild before hydration" : previouslyHydrated ? "upgrade" : "first boot"}`,
    (it) => {
      it.effect(
        `Mesura v046 imports all Factory card kinds ${rebuildBeforeHydration ? "with durable reservations through rebuild before lazy hydration" : previouslyHydrated ? "after an earlier message-only migration" : "before lazy transcripts"} and preserves them across restart and replay`,
        () =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
            const projections = yield* ProjectionStore.ProjectionStoreV2;
            const cards = yield* FactoryCardQuery.FactoryCardQuery;
            const threadId = ThreadId.make("thread:historical-factory");
            const planId = factoryPlanCardId(threadId, "a".repeat(64));
            const runId = factoryRunActivityId(threadId, "unfinished");
            const reportId = factoryReportActivityId(threadId, "unfinished");
            yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES (
          ${threadId}, 'project:historical-factory', 'Historical Factory',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
          '2026-01-01T00:00:00.000Z', '2026-01-05T00:00:00.000Z'
        )
      `;
            for (const [id, role, day] of [
              ["old", "user", 1],
              ["answer", "assistant", 3],
              ["latest", "user", 5],
            ] as const) {
              const at = `2026-01-0${day}T00:00:00.000Z`;
              yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, role, text, is_streaming, created_at, updated_at
          ) VALUES (${`historical:${id}`}, ${threadId}, ${role}, ${id}, 0, ${at}, ${at})
        `;
            }
            if (previouslyHydrated) {
              yield* importer.reconcileShells;
              yield* importer.ensureTranscript(threadId);
            }
            const plan = {
              digest: "a".repeat(64),
              intentDigest: "b".repeat(64),
              planPath: "/plans/plan.md",
              intentPath: "/plans/intent.md",
              title: "Plan: Keep history",
              phases: [],
              headings: [],
              presentedAt: "2026-01-02T00:00:00.000Z",
            };
            const run = fixtureRunPayload(threadId, "unfinished", "running");
            const report = {
              runId: "unfinished",
              digest: "c".repeat(64),
              path: "/runs/unfinished/report.md",
              title: "Report: Partial progress",
              headings: [],
              writtenAt: "2026-01-04T00:00:00.000Z",
            };
            for (const [id, kind, payload, day, sequence] of [
              [planId, "factory.plan", plan, 2, 10],
              [runId, "factory.run", run, 4, 11],
              [reportId, "factory.report", report, 4, 12],
            ] as const) {
              yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, tone, kind, summary, payload_json, created_at, sequence
          ) VALUES (${id}, ${threadId}, 'info', ${kind}, 'Factory', ${JSON.stringify(payload)},
            ${`2026-01-0${day}T00:00:00.000Z`}, ${sequence})
        `;
            }
            yield* importer.reconcileShells;
            const shell = yield* projections.getThreadProjection(threadId);
            if (!previouslyHydrated && !rebuildBeforeHydration) {
              assert.deepStrictEqual(
                shell.thread.updatedAt,
                DateTime.makeUnsafe("2026-01-05T00:00:00.000Z"),
                "Historical card import must preserve the shell activity timestamp",
              );
            }
            assert.deepStrictEqual(
              shell.turnItems.filter((item) => item.type === "factory_card").map((item) => item.id),
              [planId, runId, reportId],
            );
            assert.equal(
              shell.messages.length,
              previouslyHydrated ? 3 : 1,
              "Factory import must not hydrate the full transcript",
            );
            assert.deepStrictEqual(
              (yield* cards.listByKind("run")).map((record) => record.card.payload),
              [run],
            );
            assert.deepStrictEqual(
              (yield* cards.listByKind("plan")).map((record) => record.card.payload),
              [plan],
            );
            assert.deepStrictEqual(
              (yield* cards.listByKind("report")).map((record) => record.card.payload),
              [report],
            );
            if (rebuildBeforeHydration) {
              yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild;
              yield* Effect.gen(function* () {
                const restarted = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
                yield* restarted.reconcileShells;
                assert.lengthOf((yield* projections.getThreadProjection(threadId)).messages, 1);
                yield* restarted.ensureTranscript(threadId);
              }).pipe(Effect.provide(LegacyV1ThreadImporter.layer));
            } else {
              yield* importer.ensureTranscript(threadId);
            }
            const imported = yield* projections.getThreadProjection(threadId);
            if (!previouslyHydrated && !rebuildBeforeHydration) {
              assert.deepStrictEqual(imported.thread.updatedAt, shell.thread.updatedAt);
            }
            assert.deepStrictEqual(
              imported.turnItems.map((item) => [item.id, item.ordinal]),
              [
                ["migration:v1:turn-item:historical:old", 1],
                [planId, 2],
                ["migration:v1:turn-item:historical:answer", 3],
                [runId, 4],
                [reportId, 5],
                ["migration:v1:turn-item:historical:latest", 6],
              ],
            );
            for (const item of imported.turnItems.filter((item) => item.type === "factory_card")) {
              assert.equal(item.runId, null);
              assert.equal(item.status, "completed");
            }
            const eventsBefore =
              yield* sql`SELECT event_id FROM orchestration_events WHERE stream_id = ${threadId} ORDER BY sequence`;
            // A fresh importer instance must use persisted import state, not an in-memory flag.
            yield* Effect.gen(function* () {
              const restarted = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
              yield* restarted.reconcileShells;
              yield* restarted.ensureTranscript(threadId);
            }).pipe(Effect.provide(LegacyV1ThreadImporter.layer));
            assert.deepStrictEqual(
              yield* sql`SELECT event_id FROM orchestration_events WHERE stream_id = ${threadId} ORDER BY sequence`,
              eventsBefore,
            );
            yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild;
            assert.deepStrictEqual(
              (yield* projections.getThreadProjection(threadId)).turnItems,
              imported.turnItems,
            );
            assert.deepStrictEqual(
              (yield* projections.getThreadProjection(threadId)).thread.updatedAt,
              imported.thread.updatedAt,
            );
            assert.equal((yield* cards.listByKind("run"))[0]?.turnItemId, runId);
          }),
      );
    },
  );
}
