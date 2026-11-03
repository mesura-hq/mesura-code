// Entry point: McpServer.callTool on the real thread toolkit, with the real client-zone store.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { McpServer } from "effect/ai";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../../config.ts";
import * as ClientTimeZone from "../../../orchestration-v2/ClientTimeZone.ts";
import { makeOrganizeServer, TARGET } from "./organize.testkit.ts";

it.effect.each([
  {
    source: "setting",
    setting: "Asia/Tokyo",
    device: "Europe/Madrid",
    zone: "Asia/Tokyo",
    until: "2026-03-08T00:00:00.000Z",
  },
  {
    source: "device",
    setting: null,
    device: "Asia/Kathmandu",
    zone: "Asia/Kathmandu",
    until: "2026-03-08T03:15:00.000Z",
  },
  {
    source: "server",
    setting: null,
    device: null,
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    until: null,
  },
] as const)("snooze-zone AC2 MCP spec: local time resolves from the $source source", (testCase) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(
      DateTime.toEpochMillis(DateTime.makeUnsafe("2026-03-07T00:00:00.000Z")),
    );
    const storeLayer = ClientTimeZone.layer.pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "snooze-zone-mcp-" })),
      Layer.provide(NodeServices.layer),
    );
    const storeContext = yield* Layer.build(storeLayer);
    const store = yield* ClientTimeZone.ClientTimeZone.pipe(Effect.provide(storeContext));
    if (testCase.device !== null) yield* store.report(testCase.device);
    const harness = yield* makeOrganizeServer(
      McpServer,
      { snoozeTimeZone: testCase.setting },
      Layer.succeedContext(storeContext),
    );
    const result = yield* harness.call({
      action: "snooze",
      threadId: TARGET,
      snoozeUntilLocal: "2026-03-08T09:00",
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      timeZone: testCase.zone,
      timeZoneSource: testCase.source,
    });
    const resolved = result.structuredContent as { snoozedUntil: string };
    if (testCase.until !== null) expect(resolved.snoozedUntil).toBe(testCase.until);
    else {
      const localParts = new Intl.DateTimeFormat("en-CA", {
        timeZone: testCase.zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(DateTime.toEpochMillis(DateTime.makeUnsafe(resolved.snoozedUntil)));
      const part = (type: Intl.DateTimeFormatPartTypes) =>
        localParts.find((value) => value.type === type)?.value;
      expect(
        `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`,
      ).toBe("2026-03-08T09:00");
    }
    expect(harness.commands).toEqual([
      expect.objectContaining({
        type: "thread.snooze",
        threadId: TARGET,
        snoozedUntil: resolved.snoozedUntil,
      }),
    ]);
  }).pipe(Effect.scoped),
);

const organizeWithDeviceZone = Effect.fn("SnoozeDayFence.organizeWithDeviceZone")(function* (
  device: string,
) {
  const storeLayer = ClientTimeZone.layer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "snooze-day-mcp-" })),
    Layer.provide(NodeServices.layer),
  );
  const storeContext = yield* Layer.build(storeLayer);
  const store = yield* ClientTimeZone.ClientTimeZone.pipe(Effect.provide(storeContext));
  yield* store.report(device);
  return yield* makeOrganizeServer(McpServer, {}, Layer.succeedContext(storeContext));
});

// 2026-03-08T02:00Z is Saturday 2026-03-07 21:00 in New York and already Sunday in UTC.
const NEW_YORK_EVENING = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-03-08T02:00:00.000Z"));

const resultText = (result: { readonly content: ReadonlyArray<{ type: string; text?: string }> }) =>
  result.content
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("\n");

it.effect(
  "snooze-day AC1 MCP spec: tomorrow 09:00 resolves in the device zone while UTC is a day ahead",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NEW_YORK_EVENING);
      const harness = yield* organizeWithDeviceZone("America/New_York");
      const result = yield* harness.call({
        action: "snooze",
        threadId: TARGET,
        snoozeDay: "tomorrow",
        snoozeAt: "09:00",
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        snoozedUntil: "2026-03-08T13:00:00.000Z",
        snoozedUntilLocal: "2026-03-08T09:00",
        timeZone: "America/New_York",
        timeZoneSource: "device",
      });
      expect(harness.commands).toEqual([
        expect.objectContaining({
          type: "thread.snooze",
          threadId: TARGET,
          snoozedUntil: "2026-03-08T13:00:00.000Z",
        }),
      ]);
    }).pipe(Effect.scoped),
);

it.effect.each([
  {
    title: "today at a time still ahead",
    args: { snoozeDay: "today", snoozeAt: "22:30" },
    until: "2026-03-08T03:30:00.000Z",
    local: "2026-03-07T22:30",
  },
  {
    title: "a weekday named for the zone's tomorrow",
    args: { snoozeDay: "sunday", snoozeAt: "09:00" },
    until: "2026-03-08T13:00:00.000Z",
    local: "2026-03-08T09:00",
  },
  {
    title: "the zone's own weekday",
    args: { snoozeDay: "saturday", snoozeAt: "09:00" },
    until: "2026-03-14T13:00:00.000Z",
    local: "2026-03-14T09:00",
  },
  {
    title: "an argument zone",
    args: { snoozeDay: "tomorrow", snoozeAt: "09:00", timeZone: "Asia/Tokyo" },
    until: "2026-03-09T00:00:00.000Z",
    local: "2026-03-09T09:00",
  },
] as const)("snooze-day AC2-AC4 MCP spec: snoozes to $title", (testCase) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NEW_YORK_EVENING);
    const harness = yield* organizeWithDeviceZone("America/New_York");
    const result = yield* harness.call({ action: "snooze", threadId: TARGET, ...testCase.args });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      snoozedUntil: testCase.until,
      snoozedUntilLocal: testCase.local,
    });
    expect(harness.commands).toEqual([
      expect.objectContaining({ type: "thread.snooze", snoozedUntil: testCase.until }),
    ]);
  }).pipe(Effect.scoped),
);

const pairMessage = /snoozeDay[^.]*snoozeAt|snoozeAt[^.]*snoozeDay/i;

it.effect.each([
  {
    title: "today at a time already passed",
    args: { snoozeDay: "today", snoozeAt: "09:00" },
    message: /America\/New_York[\s\S]*21:00|21:00[\s\S]*America\/New_York/,
  },
  { title: "a day without a clock time", args: { snoozeDay: "tomorrow" }, message: pairMessage },
  { title: "a clock time without a day", args: { snoozeAt: "09:00" }, message: pairMessage },
  {
    title: "a clock time that is not HH:MM",
    args: { snoozeDay: "tomorrow", snoozeAt: "9am" },
    message: /HH:MM/,
  },
  {
    title: "a day plus minutes",
    args: { snoozeDay: "tomorrow", snoozeAt: "09:00", snoozeForMinutes: 60 },
    message: /exactly one[^.]*snoozeDay/i,
  },
  {
    title: "a day plus a local time",
    args: { snoozeDay: "tomorrow", snoozeAt: "09:00", snoozeUntilLocal: "2026-03-09T09:00" },
    message: /exactly one[^.]*snoozeDay/i,
  },
  {
    title: "a day plus an absolute time",
    args: { snoozeDay: "tomorrow", snoozeAt: "09:00", snoozedUntil: "2026-03-09T13:00:00.000Z" },
    message: /exactly one[^.]*snoozeDay/i,
  },
] as const)(
  "snooze-day AC2-AC4 MCP spec: refuses $title with a readable error and no dispatch",
  (refusal) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NEW_YORK_EVENING);
      const harness = yield* organizeWithDeviceZone("America/New_York");
      const result = yield* harness.call({ action: "snooze", threadId: TARGET, ...refusal.args });
      expect(harness.commands).toEqual([]);
      expect(result.isError).toBe(true);
      expect(resultText(result)).toMatch(refusal.message);
    }).pipe(Effect.scoped),
);

// The tool schema owns the day words, so the MCP layer rejects an unknown one as invalid params.
it.effect(
  "snooze-day AC4 MCP spec: an unknown day word fails as invalid params that name snoozeDay and dispatches nothing",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NEW_YORK_EVENING);
      const harness = yield* organizeWithDeviceZone("America/New_York");
      const failure = yield* harness
        .call({ action: "snooze", threadId: TARGET, snoozeDay: "someday", snoozeAt: "09:00" })
        .pipe(Effect.flip);
      expect(harness.commands).toEqual([]);
      expect(failure.message).toMatch(/snoozeDay/);
      expect(failure.message).not.toMatch(/excess property/i);
    }).pipe(Effect.scoped),
);

it.effect(
  "snooze-day AC7 MCP spec: the organize tool steers relative days to snoozeDay with one more sentence",
  () =>
    Effect.gen(function* () {
      const { server } = yield* makeOrganizeServer(McpServer);
      const tool = server.tools.find(({ tool }) => tool.name === "t3_thread_organize")?.tool;
      expect(tool).toBeDefined();
      for (const name of ["snoozeDay", "snoozeAt"]) {
        expect(tool?.inputSchema.properties).toHaveProperty(name);
      }
      const sentences = (tool?.description ?? "")
        .split(/\.(?:\s|$)/)
        .filter((sentence) => sentence.trim());
      // The base description at 0c33aa64db has six sentences.
      expect(sentences.length).toBeLessThanOrEqual(7);
      const daySentence = sentences.find((sentence) => sentence.includes("`snoozeDay`"));
      expect(daySentence).toBeDefined();
      expect(daySentence).toContain("`snoozeAt`");
      expect(daySentence).toMatch(/tomorrow/i);
      expect(daySentence).toMatch(/weekday/i);
    }),
);
