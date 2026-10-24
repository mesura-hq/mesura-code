// Entry points: `planFactoryCardRecord`, the decision behind the orchestrator's
// `factory_card.record`, and the thread shells `ProjectionStoreV2` reads, which
// carry the Software Factory run label from `FactoryRunShellSummaries`.
import { assert, describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  type FactoryReportActivityPayload,
  type FactoryRunShellSummary,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ThreadId,
  TurnItemId,
  factoryPlanCardId,
  factoryReportActivityId,
  factoryRunActivityId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as FactoryRunShellSummaries from "../factory/FactoryRunShellSummaries.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  factoryCardTitle,
  planFactoryCardRecord,
  type FactoryCardRecordCommand,
} from "./FactoryCards.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  FIXTURE_EPOCH,
  applyFixtureThread,
  fixtureCardItem,
  fixtureRun,
  fixtureRunPayload,
} from "./testkit/factoryCardFixtures.ts";

const THREAD_ID = ThreadId.make("thread:factory");
const LATER = DateTime.makeUnsafe("2026-10-11T01:00:00.000Z");
const RUN_CARD_ID = TurnItemId.make(factoryRunActivityId(THREAD_ID, "run-a"));
const REPORT_PAYLOAD: FactoryReportActivityPayload = {
  runId: "run-a",
  digest: "a".repeat(64),
  path: "/runs/run-a/report.md",
  title: "Report: run a",
  headings: [],
  writtenAt: "2026-10-11T00:00:00.000Z",
};

const runCardCommand = (
  status: "running" | "done" = "running",
  turnItemId: TurnItemId = RUN_CARD_ID,
): FactoryCardRecordCommand => ({
  type: "factory_card.record",
  commandId: CommandId.make(`command:factory:${status}`),
  threadId: THREAD_ID,
  turnItemId,
  card: { kind: "run", payload: fixtureRunPayload(THREAD_ID, "run-a", status) },
});

const decodeTurnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);

const importedRunCard = () => {
  const item = decodeTurnItem({
    ...fixtureCardItem({ id: RUN_CARD_ID, threadId: THREAD_ID, card: runCardCommand().card }),
    runId: null,
    nodeId: null,
    providerThreadId: null,
  });
  assert(item.type === "factory_card");
  return item;
};

const projectionOf = (
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem> = [],
  deletedAt: DateTime.Utc | null = null,
): Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "turnItems"> => ({
  // Only `deletedAt` of the thread is read.
  thread: { deletedAt } as OrchestrationV2ThreadProjection["thread"],
  runs,
  turnItems,
});

const plan = (
  command: FactoryCardRecordCommand,
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "turnItems">,
  now: DateTime.Utc = FIXTURE_EPOCH,
) => planFactoryCardRecord({ command, projection, nextOrdinal: 42, now });

describe("planFactoryCardRecord", () => {
  it("Mesura P1-3 permits a first report only for a matching imported run and keeps ordinary provider anchors", () => {
    const command: FactoryCardRecordCommand = {
      type: "factory_card.record",
      commandId: CommandId.make("command:first-report:planner"),
      threadId: THREAD_ID,
      turnItemId: TurnItemId.make(factoryReportActivityId(THREAD_ID, REPORT_PAYLOAD.runId)),
      card: { kind: "report", payload: REPORT_PAYLOAD },
    };
    const imported = importedRunCard();
    for (const invalid of [
      [],
      [{ ...imported, threadId: ThreadId.make("thread:unrelated") }],
      [
        {
          ...imported,
          card: {
            kind: "run" as const,
            payload: fixtureRunPayload(THREAD_ID, "different", "running"),
          },
        },
      ],
      [
        {
          ...imported,
          card: {
            kind: "run" as const,
            payload: fixtureRunPayload(ThreadId.make("thread:unrelated"), "run-a", "running"),
          },
        },
      ],
      [{ ...imported, runId: fixtureRun(THREAD_ID, 1).id }],
    ]) {
      expect(plan(command, projectionOf([], invalid))).toMatchObject({ _tag: "reject" });
    }
    expect(
      plan(
        runCardCommand("running", TurnItemId.make("unrelated:new-run")),
        projectionOf([], [imported]),
      ),
    ).toMatchObject({ _tag: "reject" });
    const ordinary = plan(command, projectionOf([fixtureRun(THREAD_ID, 2, "running")], [imported]));
    assert(ordinary._tag === "record");
    expect(ordinary.turnItem.runId).toBe(fixtureRun(THREAD_ID, 2).id);
    const legacy = plan(command, projectionOf([], [imported]), LATER);
    assert(legacy._tag === "record");
    expect(legacy.run).toBeNull();
    expect(legacy.turnItem).toMatchObject({
      ordinal: 42,
      runId: null,
      nodeId: null,
      startedAt: LATER,
    });
  });
  it("Mesura v046 updates imported Factory cards without adopting a provider run or changing their history anchor", () => {
    for (const runs of [[], [fixtureRun(THREAD_ID, 2, "running")]]) {
      for (const startedAt of [FIXTURE_EPOCH, null]) {
        const imported = {
          ...importedRunCard(),
          ordinal: 7,
          startedAt,
        };
        const decision = plan(runCardCommand("done"), projectionOf(runs, [imported]), LATER);
        assert(decision._tag === "record");
        expect(decision.run).toBeNull();
        expect(decision.turnItem).toMatchObject({
          id: RUN_CARD_ID,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          ordinal: 7,
          startedAt,
          updatedAt: LATER,
          completedAt: LATER,
          card: runCardCommand("done").card,
        });
      }
    }
  });

  it("Mesura v046 rejects a Factory card whose non-null anchor disappeared even when another run exists", () => {
    const anchored = fixtureCardItem({
      id: RUN_CARD_ID,
      threadId: THREAD_ID,
      card: runCardCommand().card,
    });
    expect(
      plan(runCardCommand("done"), projectionOf([fixtureRun(THREAD_ID, 2, "running")], [anchored])),
    ).toMatchObject({ _tag: "reject", reason: expect.stringContaining("is gone") });
  });

  it("anchors a new card to the newest active run, completed, at the next ordinal", () => {
    const decision = plan(
      runCardCommand(),
      projectionOf([
        fixtureRun(THREAD_ID, 1),
        fixtureRun(THREAD_ID, 2, "running"),
        fixtureRun(THREAD_ID, 3, "queued"),
      ]),
    );

    assert(decision._tag === "record");
    assert(decision.run !== null);
    expect(decision.run.ordinal).toBe(2);
    expect(decision.turnItem).toMatchObject({
      id: RUN_CARD_ID,
      threadId: THREAD_ID,
      runId: fixtureRun(THREAD_ID, 2).id,
      nodeId: fixtureRun(THREAD_ID, 2).rootNodeId,
      ordinal: 42,
      status: "completed",
      startedAt: FIXTURE_EPOCH,
      completedAt: FIXTURE_EPOCH,
      updatedAt: FIXTURE_EPOCH,
      type: "factory_card",
      card: runCardCommand().card,
      title: "Factory run run-a: running",
    });
  });

  it("anchors to the newest run that left the queue when no run is active", () => {
    const decision = plan(
      runCardCommand(),
      projectionOf([
        fixtureRun(THREAD_ID, 1),
        fixtureRun(THREAD_ID, 2, "interrupted"),
        fixtureRun(THREAD_ID, 3, "queued"),
      ]),
    );

    assert(decision._tag === "record");
    assert(decision.run !== null);
    expect(decision.run.ordinal).toBe(2);
  });

  it("refuses a thread with no run, and a deleted thread", () => {
    expect(plan(runCardCommand(), projectionOf([]))).toMatchObject({
      _tag: "reject",
      reason: expect.stringContaining("has no run"),
    });
    expect(
      plan(runCardCommand(), projectionOf([fixtureRun(THREAD_ID, 1)], [], FIXTURE_EPOCH)),
    ).toMatchObject({ _tag: "reject", reason: expect.stringContaining("deleted") });
  });

  it("updates an existing card in place: same run, ordinal and start, new payload and time", () => {
    const first = plan(runCardCommand(), projectionOf([fixtureRun(THREAD_ID, 1, "running")]));
    assert(first._tag === "record");
    const recorded = { ...first.turnItem, ordinal: 1_000_001 };

    // A newer run is active now; the card stays with the run it was recorded on.
    const second = plan(
      runCardCommand("done"),
      projectionOf([fixtureRun(THREAD_ID, 1), fixtureRun(THREAD_ID, 2, "running")], [recorded]),
      LATER,
    );

    assert(second._tag === "record");
    assert(second.run !== null);
    expect(second.run.ordinal).toBe(1);
    expect(second.turnItem).toMatchObject({
      runId: recorded.runId,
      nodeId: recorded.nodeId,
      ordinal: 1_000_001,
      startedAt: FIXTURE_EPOCH,
      updatedAt: LATER,
      completedAt: LATER,
      card: runCardCommand("done").card,
      title: "Factory run run-a: done",
    });
  });

  it("refuses an id that holds another turn item or another kind of card", () => {
    const run = fixtureRun(THREAD_ID, 1, "running");
    const notACard: OrchestrationV2TurnItem = {
      ...fixtureCardItem({ id: RUN_CARD_ID, threadId: THREAD_ID, card: runCardCommand().card }),
      type: "system_notice",
      message: "not a card",
    } as OrchestrationV2TurnItem;
    expect(plan(runCardCommand(), projectionOf([run], [notACard]))).toMatchObject({
      _tag: "reject",
      reason: expect.stringContaining("not a Software Factory card"),
    });

    const reportId = TurnItemId.make(factoryReportActivityId(THREAD_ID, "run-a"));
    const reportCard = fixtureCardItem({
      id: reportId,
      threadId: THREAD_ID,
      card: {
        kind: "report",
        payload: REPORT_PAYLOAD,
      },
    });
    expect(
      plan(runCardCommand("running", reportId), projectionOf([run], [reportCard])),
    ).toMatchObject({ _tag: "reject", reason: expect.stringContaining("is a report card") });
  });
});

describe("factoryCardTitle", () => {
  it("names each kind the way the v1 activity summaries did", () => {
    expect(
      factoryCardTitle({
        kind: "plan",
        payload: {
          digest: "a".repeat(64),
          intentDigest: "b".repeat(64),
          planPath: "/plans/plan.md",
          intentPath: "/plans/intent.md",
          title: "Plan: something worth building",
          phases: [],
          headings: [],
          presentedAt: "2026-10-11T00:00:00.000Z",
        },
      }),
    ).toBe("Plan: something worth building");
    expect(
      factoryCardTitle({
        kind: "run",
        payload: {
          ...fixtureRunPayload(THREAD_ID, "run-a", "running"),
          phaseCount: 11,
          phase: { index: 5, title: "Review" },
          node: "review",
        },
      }),
    ).toBe("Factory run run-a: running · phase 5/11 · review");
    expect(
      factoryCardTitle({
        kind: "report",
        payload: REPORT_PAYLOAD,
      }),
    ).toBe("Report: run a");
    expect(factoryPlanCardId(THREAD_ID, "c".repeat(64))).toBe(
      `factory-plan:${THREAD_ID}:${"c".repeat(16)}`,
    );
  });
});

const SUMMARY: FactoryRunShellSummary = {
  status: "running",
  phaseIndex: 5,
  phaseCount: 11,
  node: "review",
};

const layerWithSummaries = ProjectionStore.layer.pipe(
  Layer.provideMerge(FactoryRunShellSummaries.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.layer(layerWithSummaries)("thread shells with FactoryRunShellSummaries", (it) => {
  it.effect("carry the run label of a thread that has one, and no key on any other", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const summaries = yield* FactoryRunShellSummaries.FactoryRunShellSummaries;
      const labelled = yield* applyFixtureThread("labelled");
      const plain = yield* applyFixtureThread("plain");
      const archived = yield* applyFixtureThread("archived-labelled", { archived: true });
      summaries.set(labelled, SUMMARY);
      summaries.set(archived, { ...SUMMARY, status: "done" });

      expect((yield* projections.getThreadShell(labelled))?.factoryRun).toEqual(SUMMARY);
      expect(Object.hasOwn((yield* projections.getThreadShell(plain))!, "factoryRun")).toBe(false);

      const snapshot = yield* projections.getShellSnapshot();
      expect(snapshot.threads.find((thread) => thread.id === labelled)?.factoryRun).toEqual(
        SUMMARY,
      );
      expect(
        Object.hasOwn(
          snapshot.threads.find((thread) => thread.id === plain)!,
          "factoryRun",
        ),
      ).toBe(false);
      expect(
        snapshot.archivedThreads.find((thread) => thread.id === archived)?.factoryRun,
      ).toMatchObject({ status: "done" });

      // A later summary is what the next shell read reports.
      summaries.set(labelled, { ...SUMMARY, phaseIndex: 6 });
      expect((yield* projections.getThreadShell(labelled))?.factoryRun?.phaseIndex).toBe(6);
    }),
  );
});

it.layer(ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))(
  "thread shells without FactoryRunShellSummaries",
  (it) => {
    it.effect("carry no factoryRun key", () =>
      Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const threadId = yield* applyFixtureThread("no-factory");
        expect(Object.hasOwn((yield* projections.getThreadShell(threadId))!, "factoryRun")).toBe(
          false,
        );
      }),
    );
  },
);
