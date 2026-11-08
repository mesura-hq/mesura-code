/**
 * Entry point: the Factory derivations consumed by ChatView and report cards.
 * These fixtures carry the factory_card payload the v2 projection stores.
 */
/// <reference types="vite-plus/client" />
import { ThreadId, type FactoryThreadCard } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import eventsJsonl from "../../../shared/src/fixtures/factory-events.v1.jsonl?raw";
import { deriveFactoryTimelineItemsFromTurnItems } from "./planActivities.js";
import {
  deriveFactoryRunItemsByIdFromTurnItems,
  deriveLatestFactoryRunItemFromTurnItems,
} from "./runActivities.js";
import {
  makeFactoryCardTurnItem,
  makeFactoryReportPayload,
  makeFactoryRunSummary,
} from "./testing.js";

const threadId = ThreadId.make("factory-derivation-thread");
const summary = makeFactoryRunSummary(eventsJsonl, "verify");
const at = (hour: string) => `2026-09-28T${hour}:00:00.000Z`;
const run = (id: string, startedAt: string | null, createdAt: string, updatedAt = createdAt) =>
  makeFactoryCardTurnItem({
    id: `factory-run:${id}`,
    threadId,
    createdAt,
    updatedAt,
    card: { kind: "run", payload: { ...summary, threadId, runId: id, startedAt } },
  });

describe("Factory v2 run derivation regressions", () => {
  it("Factory v2 run anchor uses the run start when attachment arrives later", () => {
    const item = run("newer", at("09"), at("12"));
    const [derived] = deriveFactoryRunItemsByIdFromTurnItems([{ item }]).values();
    expect(derived?.createdAt).toBe(at("09"));
  });

  it("Factory v2 run without a start retains its first attachment anchor across updates", () => {
    const item = run("pending", null, at("09"), at("12"));
    expect(deriveLatestFactoryRunItemFromTurnItems([{ item }])?.createdAt).toBe(at("09"));
  });

  it("Factory v2 newest run survives an older attachment at the end of the projection", () => {
    const newer = run("newer", at("09"), at("09"));
    const older = run("older", at("07"), at("12"));
    for (const items of [
      [newer, older],
      [older, newer],
    ]) {
      expect(
        deriveLatestFactoryRunItemFromTurnItems(items.map((item) => ({ item })))?.run.runId,
      ).toBe("newer");
    }
  });

  it.each([
    ["offset", "2026-09-28T11:00:00+02:00", at("10")],
    ["whole second", "2026-09-28T09:00:00Z", "2026-09-28T09:00:00.500Z"],
  ])(
    "Factory v2 latest run orders a %s start by absolute time",
    (_format, olderStart, newerStart) => {
      const older = run("older", olderStart, at("12"));
      const newer = run("newer", newerStart, at("11"));
      for (const items of [
        [older, newer],
        [newer, older],
      ]) {
        const entries = items.map((item) => ({ item }));
        const byId = deriveFactoryRunItemsByIdFromTurnItems(entries);
        expect(byId.get("older")?.createdAt).toBe(at("09"));
        expect(deriveLatestFactoryRunItemFromTurnItems(entries)).toBe(byId.get("newer"));
        expect(deriveFactoryRunItemsByIdFromTurnItems(entries).get("older")).toBe(
          byId.get("older"),
        );
      }
    },
  );

  it("Factory v2 invalid run start uses the recorded card time without throwing or losing identity", () => {
    const invalid = run("invalid", "not-a-timestamp", at("09"), at("12"));
    const newer = run("newer", at("10"), at("10"));
    for (const items of [
      [invalid, newer],
      [newer, invalid],
    ]) {
      const entries = items.map((item) => ({ item }));
      const byId = deriveFactoryRunItemsByIdFromTurnItems(entries);
      expect(byId.get("invalid")?.createdAt).toBe(at("09"));
      expect(deriveLatestFactoryRunItemFromTurnItems(entries)).toBe(byId.get("newer"));
      expect(deriveFactoryRunItemsByIdFromTurnItems(entries).get("invalid")).toBe(
        byId.get("invalid"),
      );
    }
    const withoutRecordedStart = { ...invalid, startedAt: null };
    expect(
      deriveLatestFactoryRunItemFromTurnItems([{ item: withoutRecordedStart }])?.createdAt,
    ).toBe(at("12"));
  });

  it("Factory v2 report reads its own run after a newer run attaches", () => {
    const older = run(summary.runId, at("07"), at("09"));
    const newer = run("newer", at("10"), at("10"));
    const payload = makeFactoryReportPayload({ runId: summary.runId });
    const report = makeFactoryCardTurnItem({
      id: "report",
      threadId,
      createdAt: at("11"),
      card: { kind: "report", payload },
    });
    const items = deriveFactoryTimelineItemsFromTurnItems(
      [older, newer, report].map((item) => ({ item })),
    );
    expect(items[0]?.kind === "report" && items[0].run?.run.runId).toBe(summary.runId);
  });

  it("Factory v2 malformed run payload cannot replace a valid run card", () => {
    const valid = run("newer", at("09"), at("09"));
    const malformed = makeFactoryCardTurnItem({
      id: "broken-run",
      threadId,
      createdAt: at("12"),
      card: { kind: "run", payload: { runId: "broken" } } as unknown as FactoryThreadCard,
    });
    expect(
      deriveLatestFactoryRunItemFromTurnItems([{ item: valid }, { item: malformed }])?.run.runId,
    ).toBe("newer");
  });

  it("Factory v2 immutable run item keeps the decoded card identity", () => {
    const item = run("newer", at("09"), at("10"));
    const before = deriveLatestFactoryRunItemFromTurnItems([{ item }]);
    expect(deriveLatestFactoryRunItemFromTurnItems([{ item }])).toBe(before);
  });
});
