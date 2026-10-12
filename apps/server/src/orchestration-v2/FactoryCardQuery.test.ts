// Entry point: `FactoryCardQuery` over an in-memory SQLite database whose
// cards were written through `ProjectionStoreV2.apply`, as the event sink does.
import { expect, it } from "@effect/vitest";
import {
  factoryPlanCardId,
  factoryReportActivityId,
  factoryRunActivityId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as FactoryCardQuery from "./FactoryCardQuery.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  applyFixtureItem,
  applyFixtureThread,
  fixtureCardItem,
  fixtureRunCardItem,
  fixtureRunPayload,
} from "./testkit/factoryCardFixtures.ts";

const at = (minute: number) =>
  DateTime.makeUnsafe(`2026-10-11T00:${String(minute).padStart(2, "0")}:00.000Z`);

const layerTest = Layer.mergeAll(ProjectionStore.layer, FactoryCardQuery.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it("each kind's id prefix is what the contract's id helper writes", () => {
  expect(factoryPlanCardId("t", "d".repeat(64))).toMatch(
    new RegExp(`^${FactoryCardQuery.FACTORY_CARD_ID_PREFIXES.plan}`),
  );
  expect(factoryRunActivityId("t", "r")).toMatch(
    new RegExp(`^${FactoryCardQuery.FACTORY_CARD_ID_PREFIXES.run}`),
  );
  expect(factoryReportActivityId("t", "r")).toMatch(
    new RegExp(`^${FactoryCardQuery.FACTORY_CARD_ID_PREFIXES.report}`),
  );
});

it.layer(layerTest)("FactoryCardQuery", (it) => {
  it.effect(
    "lists one kind across live and archived threads, oldest first, without deleted threads",
    () =>
      Effect.gen(function* () {
        const query = yield* FactoryCardQuery.FactoryCardQuery;
        const live = yield* applyFixtureThread("live");
        const archived = yield* applyFixtureThread("archived", { archived: true });
        const deleted = yield* applyFixtureThread("deleted", { deleted: true });

        yield* applyFixtureItem(
          fixtureRunCardItem({ threadId: live, runId: "run-new", updatedAt: at(3) }),
        );
        yield* applyFixtureItem(
          fixtureRunCardItem({ threadId: archived, runId: "run-old", updatedAt: at(1) }),
        );
        yield* applyFixtureItem(
          fixtureRunCardItem({ threadId: deleted, runId: "run-gone", updatedAt: at(2) }),
        );
        // A report card of the same run is another kind and stays out of the list.
        yield* applyFixtureItem(
          fixtureCardItem({
            id: TurnItemId.make(factoryReportActivityId(live, "run-new")),
            threadId: live,
            card: {
              kind: "report",
              payload: {
                runId: "run-new",
                digest: "a".repeat(64),
                path: "/runs/run-new/report.md",
                title: "Report",
                headings: [],
                writtenAt: "2026-10-11T00:04:00.000Z",
              },
            },
            updatedAt: at(4),
          }),
        );

        const runs = yield* query.listByKind("run");

        expect(runs.map((record) => [record.threadId, record.card.payload.runId])).toEqual([
          [archived, "run-old"],
          [live, "run-new"],
        ]);
        expect(runs[1]).toEqual({
          turnItemId: factoryRunActivityId(live, "run-new"),
          threadId: live,
          card: { kind: "run", payload: fixtureRunPayload(live, "run-new") },
          updatedAt: at(3),
        });
        expect((yield* query.listByKind("report")).map((record) => record.card.kind)).toEqual([
          "report",
        ]);
        expect(yield* query.listByKind("plan")).toEqual([]);
      }),
  );

  it.effect("keeps the newest cards when the limit cuts the list, and an update moves a card", () =>
    Effect.gen(function* () {
      const query = yield* FactoryCardQuery.FactoryCardQuery;
      const threadId = yield* applyFixtureThread("limit");
      for (const minute of [10, 11, 12]) {
        yield* applyFixtureItem(
          fixtureRunCardItem({ threadId, runId: `run-${minute}`, updatedAt: at(minute) }),
        );
      }
      // The oldest run reports again: its card is now the newest.
      yield* applyFixtureItem(
        fixtureRunCardItem({ threadId, runId: "run-10", status: "done", updatedAt: at(13) }),
      );

      const newest = yield* query.listByKind("run", { limit: 2 });

      expect(newest.map((record) => record.card.payload.runId)).toEqual(["run-12", "run-10"]);
      expect(newest[1]?.card.payload.status).toBe("done");
    }),
  );

  it.effect("gets one card by id, and nothing for a missing id or a deleted thread", () =>
    Effect.gen(function* () {
      const query = yield* FactoryCardQuery.FactoryCardQuery;
      const live = yield* applyFixtureThread("get-live");
      const deleted = yield* applyFixtureThread("get-deleted", { deleted: true });
      yield* applyFixtureItem(fixtureRunCardItem({ threadId: live, runId: "run-a" }));
      yield* applyFixtureItem(fixtureRunCardItem({ threadId: deleted, runId: "run-b" }));

      const found = yield* query.get(TurnItemId.make(factoryRunActivityId(live, "run-a")));
      expect(Option.getOrUndefined(found)).toMatchObject({
        threadId: live,
        card: { kind: "run", payload: { runId: "run-a", runDir: "/runs/run-a" } },
      });
      expect(
        Option.isNone(yield* query.get(TurnItemId.make(factoryRunActivityId(live, "missing")))),
      ).toBe(true);
      expect(
        Option.isNone(yield* query.get(TurnItemId.make(factoryRunActivityId(deleted, "run-b")))),
      ).toBe(true);
    }),
  );
});
