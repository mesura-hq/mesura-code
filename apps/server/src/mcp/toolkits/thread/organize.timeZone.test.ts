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
