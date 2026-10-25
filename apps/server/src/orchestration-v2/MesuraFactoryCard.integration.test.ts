// Entry points: LegacyV1ThreadImporter.reconcileShells and OrchestratorV2.dispatch.
// The production command, event sink, event store and projections use synthetic SQLite rows.
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ThreadId,
  TurnItemId,
  type FactoryThreadCard,
  factoryPlanCardId,
  factoryRunActivityId,
  factoryReportActivityId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as FactoryRunShellSummaries from "../factory/FactoryRunShellSummaries.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as FactoryCardQuery from "./FactoryCardQuery.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { fixtureRunPayload } from "./testkit/factoryCardFixtures.ts";

const database = SqlitePersistence.layerMemory;
const runtime = ProviderReplayHarness.layerWithRegistry(
  { name: "mesura-factory-card-lifecycle" },
  ProviderAdapterRegistry.layerFromAdapters([]),
  { databaseLayer: database, runEffectWorker: false },
);
const stores = Layer.mergeAll(ProjectionStore.layer, EventStore.layer, FactoryCardQuery.layer).pipe(
  Layer.provideMerge(database),
);
const testLayer = Layer.mergeAll(
  stores,
  ProjectionMaintenance.layer.pipe(Layer.provide(stores)),
  LegacyV1ThreadImporter.layer.pipe(Layer.provideMerge(runtime), Layer.provide(database)),
);
const at = DateTime.makeUnsafe("2026-01-02T00:00:00.000Z");

const seedLegacyMessages = Effect.fn("MesuraFactoryCard.test.seed")(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode,
      interaction_mode, created_at, updated_at
    ) VALUES (${threadId}, 'project:factory-lifecycle', 'Historical Factory',
      '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
      '2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z')
  `;
  for (const [suffix, day] of [
    ["first", 1],
    ["last", 3],
  ] as const) {
    const time = `2026-01-0${day}T00:00:00.000Z`;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, is_streaming, created_at, updated_at
      ) VALUES (${`${threadId}:${suffix}`}, ${threadId}, 'user', ${suffix}, 0, ${time}, ${time})
    `;
  }
});

const insertLegacyCard = Effect.fn("MesuraFactoryCard.test.insertCard")(function* (
  threadId: ThreadId,
  id: string,
  card: FactoryThreadCard,
  sequence: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_thread_activities (
      activity_id, thread_id, tone, kind, summary, payload_json, created_at, sequence
    ) VALUES (${id}, ${threadId}, 'info', ${`factory.${card.kind}`}, 'Factory',
      ${JSON.stringify(card.payload)}, ${DateTime.formatIso(at)}, ${sequence})
  `;
});

it.layer(testLayer)("Mesura Factory lifecycle through the orchestrator", (it) => {
  it.effect(
    "keeps Factory shell labels when decoding a captured snapshot after its transaction",
    () =>
      Effect.gen(function* () {
        const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread:factory-shell-read");
        const laterThreadId = ThreadId.make("thread:factory-shell-after-read");
        const summaries = FactoryRunShellSummaries.make();
        yield* seedLegacyMessages(threadId);
        yield* importer.reconcileShells;

        yield* Effect.gen(function* () {
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const decode = yield* sql.withTransaction(projections.readShellSnapshot());
          yield* seedLegacyMessages(laterThreadId);
          yield* importer.reconcileShells;
          const summary = {
            status: "running",
            phaseIndex: 2,
            phaseCount: 3,
            node: "review",
          } as const;
          summaries.set(threadId, summary);

          const snapshot = yield* decode;
          assert.deepStrictEqual(
            snapshot.threads.find((thread) => thread.id === threadId)?.factoryRun,
            summary,
          );
          assert.isUndefined(snapshot.threads.find((thread) => thread.id === laterThreadId));
          assert.deepStrictEqual(
            (yield* projections.getThreadShell(threadId))?.factoryRun,
            summary,
          );
          const current = yield* projections.getShellSnapshot();
          assert.deepStrictEqual(
            current.threads.find((thread) => thread.id === threadId)?.factoryRun,
            summary,
          );
          const plain = current.threads.find((thread) => thread.id === laterThreadId);
          assert.isDefined(plain);
          assert.isFalse(Object.hasOwn(plain!, "factoryRun"));
        }).pipe(
          Effect.provide(
            Layer.fresh(ProjectionStore.layer).pipe(
              Layer.provide(
                Layer.succeed(FactoryRunShellSummaries.FactoryRunShellSummaries, summaries),
              ),
            ),
          ),
        );
      }),
  );

  it.effect(
    "Mesura P1-3 records the first report of an imported unfinished run through commands, retry and replay",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread:imported-first-report");
        const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const events = yield* EventStore.EventStoreV2;
        const cards = yield* FactoryCardQuery.FactoryCardQuery;
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        yield* seedLegacyMessages(threadId);
        const runId = "reattached";
        const runCardId = TurnItemId.make(factoryRunActivityId(threadId, runId));
        yield* insertLegacyCard(
          threadId,
          runCardId,
          {
            kind: "run",
            payload: fixtureRunPayload(threadId, runId, "running"),
          },
          1,
        );
        yield* importer.reconcileShells;
        const before = yield* projections.getThreadProjection(threadId);
        const importedRun = before.turnItems.find((item) => item.id === runCardId)!;
        assert.lengthOf(before.runs, 0);
        const reportId = TurnItemId.make(factoryReportActivityId(threadId, runId));
        assert(Option.isNone(yield* cards.get(reportId)));
        const command = {
          type: "factory_card.record" as const,
          commandId: CommandId.make("command:imported-first-report"),
          threadId,
          turnItemId: reportId,
          card: {
            kind: "report" as const,
            payload: {
              runId,
              digest: "d".repeat(64),
              path: "/runs/reattached/report.md",
              title: "Report: Reattached",
              headings: [],
              writtenAt: DateTime.formatIso(at),
            },
          },
        };
        const result = yield* orchestrator.dispatch(command);
        assert.lengthOf(result.storedEvents, 1);
        const persisted = yield* events
          .readByCommandId({ commandId: command.commandId })
          .pipe(Stream.runCollect);
        assert.lengthOf(persisted, 1);
        const event = persisted[0]!.event;
        assert(event.type === "turn-item.updated");
        assert.equal(event.runId, undefined);
        assert.equal(event.nodeId, undefined);
        assert.equal(event.providerInstanceId, undefined);
        const record = yield* cards.get(reportId);
        assert(Option.isSome(record));
        assert.deepStrictEqual(record.value.card, command.card);
        const recorded = yield* projections.getThreadProjection(threadId);
        const report = recorded.turnItems.find((item) => item.id === reportId)!;
        assert.equal(report.runId, null);
        assert.equal(report.nodeId, null);
        assert.equal(report.ordinal, 4, "The report must follow all reserved legacy positions");
        assert.deepStrictEqual(
          recorded.turnItems.find((item) => item.id === runCardId),
          importedRun,
        );
        const sequence = yield* events.latestSequence({ threadId });
        assert.deepStrictEqual(yield* orchestrator.dispatch(command), result);
        assert.equal(yield* events.latestSequence({ threadId }), sequence);
        yield* maintenance.rebuild;
        yield* Effect.gen(function* () {
          const restarted = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
          yield* restarted.reconcileShells;
          yield* restarted.ensureTranscript(threadId);
        }).pipe(Effect.provide(LegacyV1ThreadImporter.layer));
        const replayed = yield* projections.getThreadProjection(threadId);
        assert.lengthOf(replayed.runs, 0);
        assert.deepStrictEqual(
          replayed.turnItems.find((item) => item.id === reportId),
          report,
        );
        assert.deepStrictEqual(
          replayed.turnItems.find((item) => item.id === runCardId),
          importedRun,
        );
        assert.deepStrictEqual(yield* cards.get(reportId), record);
        assert.deepStrictEqual(yield* orchestrator.dispatch(command), result);
        assert.deepStrictEqual(
          yield* events.readByCommandId({ commandId: command.commandId }).pipe(Stream.runCollect),
          persisted,
        );
      }),
  );
  it.effect(
    "Mesura v046 persists tracker and approval updates to imported Factory cards without creating provider runs",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread:factory-lifecycle");
        const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const events = yield* EventStore.EventStoreV2;
        const cards = yield* FactoryCardQuery.FactoryCardQuery;
        const sql = yield* SqlClient.SqlClient;
        yield* seedLegacyMessages(threadId);
        const legacyCards: ReadonlyArray<readonly [string, FactoryThreadCard]> = [
          [
            factoryPlanCardId(threadId, "a".repeat(64)),
            {
              kind: "plan",
              payload: {
                digest: "a".repeat(64),
                intentDigest: "b".repeat(64),
                planPath: "/plans/plan.md",
                intentPath: "/plans/intent.md",
                title: "Plan: Original",
                phases: [],
                headings: [],
                presentedAt: DateTime.formatIso(at),
              },
            },
          ],
          [
            factoryRunActivityId(threadId, "unfinished"),
            { kind: "run", payload: fixtureRunPayload(threadId, "unfinished", "running") },
          ],
          [
            factoryReportActivityId(threadId, "unfinished"),
            {
              kind: "report",
              payload: {
                runId: "unfinished",
                digest: "c".repeat(64),
                path: "/runs/unfinished/report.md",
                title: "Report: Original",
                headings: [],
                writtenAt: DateTime.formatIso(at),
              },
            },
          ],
        ];
        for (const [index, [id, card]] of legacyCards.entries()) {
          yield* insertLegacyCard(threadId, id, card, index + 1);
        }
        yield* importer.reconcileShells;
        assert.equal((yield* cards.listByKind("run"))[0]?.card.payload.status, "running");
        const before = yield* projections.getThreadProjection(threadId);
        for (const [id, card] of legacyCards) {
          const changed: FactoryThreadCard =
            card.kind === "run"
              ? { kind: "run", payload: { ...card.payload, status: "done" } }
              : card.kind === "plan"
                ? { kind: "plan", payload: { ...card.payload, title: "Revised" } }
                : { kind: "report", payload: { ...card.payload, title: "Revised" } };
          const commandId = CommandId.make(`factory-update:${card.kind}`);
          const command = {
            type: "factory_card.record" as const,
            commandId,
            threadId,
            turnItemId: TurnItemId.make(id),
            card: changed,
          };
          const result = yield* orchestrator.dispatch(command);
          assert.lengthOf(result.storedEvents, 1);
          const persisted = yield* events.readByCommandId({ commandId }).pipe(Stream.runCollect);
          assert.lengthOf(persisted, 1);
          const event = persisted[0]!.event;
          assert(event.type === "turn-item.updated");
          assert.equal(event.payload.type, "factory_card");
          assert.equal(event.runId, undefined);
          assert.equal(event.nodeId, undefined);
          assert.equal(event.providerInstanceId, undefined);
          const record = yield* cards.get(TurnItemId.make(id));
          assert(Option.isSome(record));
          assert.deepStrictEqual(record.value.card, changed);
          const updated = (yield* projections.getThreadProjection(threadId)).turnItems.find(
            (item) => item.id === id,
          )!;
          const original = before.turnItems.find((item) => item.id === id)!;
          assert.deepStrictEqual(
            [updated.id, updated.ordinal, updated.startedAt, updated.runId, updated.nodeId],
            [original.id, original.ordinal, original.startedAt, null, null],
          );
          assert(updated.type === "factory_card");
          assert.deepStrictEqual(updated.card, changed);
          assert.equal(updated.status, "completed");
          const sequenceBeforeRetry = yield* events.latestSequence({ threadId });
          assert.deepStrictEqual(yield* orchestrator.dispatch(command), result);
          assert.equal(yield* events.latestSequence({ threadId }), sequenceBeforeRetry);
          assert.deepStrictEqual(
            yield* events.readByCommandId({ commandId }).pipe(Stream.runCollect),
            persisted,
          );
        }
        yield* importer.reconcileShells;
        assert.equal((yield* cards.listByKind("run"))[0]?.card.payload.status, "done");
        assert.lengthOf((yield* projections.getThreadProjection(threadId)).runs, 0);
        assert.deepStrictEqual(
          yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox`,
          [{ count: 0 }],
        );
      }),
  );

  it.effect(
    "Mesura v046 imports historical cards around pinned v2 history items without ordinal collisions",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread:mixed-factory-history");
        const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const sink = yield* EventSink.EventSinkV2;
        yield* seedLegacyMessages(threadId);
        yield* importer.reconcileShells;
        yield* importer.ensureTranscript(threadId);
        const noticeId = TurnItemId.make("notice:mixed-factory-history");
        const noticeAt = DateTime.makeUnsafe("2026-02-01T00:00:00.000Z");
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:mixed-factory-history:notice"),
              type: "turn-item.updated",
              threadId,
              occurredAt: noticeAt,
              payload: {
                id: noticeId,
                threadId,
                type: "system_notice",
                message: "A v2 notice",
                runId: null,
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 3,
                status: "completed",
                title: null,
                startedAt: noticeAt,
                completedAt: noticeAt,
                updatedAt: noticeAt,
              },
            },
          ],
        });
        const notice = (yield* projections.getThreadProjection(threadId)).turnItems.find(
          (item) => item.id === noticeId,
        )!;
        assert.equal(notice.ordinal, 3);
        const runId = factoryRunActivityId(threadId, "historical");
        yield* insertLegacyCard(
          threadId,
          runId,
          { kind: "run", payload: fixtureRunPayload(threadId, "historical", "running") },
          1,
        );
        yield* importer.reconcileShells;
        const imported = yield* projections.getThreadProjection(threadId);
        assert.deepStrictEqual(
          imported.thread.updatedAt,
          noticeAt,
          "Historical import must preserve newer v2 activity metadata",
        );
        assert.deepStrictEqual(
          imported.turnItems.find((item) => item.id === noticeId),
          notice,
        );
        assert.deepStrictEqual(
          imported.turnItems.map((item) => [item.id, item.ordinal]),
          [
            [`migration:v1:turn-item:${threadId}:first`, 1],
            [runId, 2],
            [noticeId, 3],
            [`migration:v1:turn-item:${threadId}:last`, 4],
          ],
        );
        yield* importer.reconcileShells;
        assert.deepStrictEqual(
          (yield* projections.getThreadProjection(threadId)).turnItems,
          imported.turnItems,
        );
        yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild;
        yield* Effect.gen(function* () {
          const restarted = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
          yield* restarted.reconcileShells;
        }).pipe(Effect.provide(LegacyV1ThreadImporter.layer));
        const replayed = yield* projections.getThreadProjection(threadId);
        assert.deepStrictEqual(replayed.thread.updatedAt, noticeAt);
        assert.deepStrictEqual(replayed.turnItems, imported.turnItems);
      }),
  );
});
