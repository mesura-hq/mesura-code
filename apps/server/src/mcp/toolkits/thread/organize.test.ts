// Entry point: McpServer.callTool on McpHttpServer.layerThreadToolkit with the real handler.
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { McpServer } from "effect/ai";
import * as TestClock from "effect/testing/TestClock";

import { makeOrganizeServer, TARGET } from "./organize.testkit.ts";

it.effect(
  "snooze-zone AC1 spec: MCP resolves minutes from the call clock and returns the wake instant",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(
        DateTime.toEpochMillis(DateTime.makeUnsafe("2026-03-07T18:15:00.000Z")),
      );
      const harness = yield* makeOrganizeServer(McpServer);
      const result = yield* harness.call({
        action: "snooze",
        threadId: TARGET,
        snoozeForMinutes: 90,
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ snoozedUntil: "2026-03-07T19:45:00.000Z" });
      expect(harness.commands).toEqual([
        expect.objectContaining({
          type: "thread.snooze",
          threadId: TARGET,
          snoozedUntil: "2026-03-07T19:45:00.000Z",
        }),
      ]);
      yield* TestClock.adjust("5 minutes");
      const later = yield* harness.call({
        action: "snooze",
        threadId: TARGET,
        snoozeForMinutes: 90,
      });
      expect(later.structuredContent).toMatchObject({ snoozedUntil: "2026-03-07T19:50:00.000Z" });
    }),
);

it.effect(
  "snooze-zone AC2 spec: MCP returns the named zone and source across the DST boundary",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(
        DateTime.toEpochMillis(DateTime.makeUnsafe("2026-03-07T18:15:00.000Z")),
      );
      const harness = yield* makeOrganizeServer(McpServer);
      const result = yield* harness.call({
        action: "snooze",
        threadId: TARGET,
        snoozeUntilLocal: "2026-03-08T09:00",
        timeZone: "America/New_York",
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        snoozedUntil: "2026-03-08T13:00:00.000Z",
        snoozedUntilLocal: "2026-03-08T09:00",
        timeZone: "America/New_York",
        timeZoneSource: "argument",
      });
      expect(harness.commands).toEqual([
        expect.objectContaining({
          type: "thread.snooze",
          threadId: TARGET,
          snoozedUntil: "2026-03-08T13:00:00.000Z",
        }),
      ]);
    }),
);

const refusals = [
  { title: "no wake input", args: {}, message: /exactly one|one of/i },
  {
    title: "absolute and relative inputs",
    args: { snoozedUntil: "2026-03-08T13:00:00.000Z", snoozeForMinutes: 10 },
    message: /exactly one|one of/i,
  },
  {
    title: "relative and local inputs",
    args: { snoozeForMinutes: 10, snoozeUntilLocal: "2026-03-08T09:00" },
    message: /exactly one|one of/i,
  },
  {
    title: "absolute and local inputs",
    args: { snoozedUntil: "2026-03-08T13:00:00.000Z", snoozeUntilLocal: "2026-03-08T09:00" },
    message: /exactly one|one of/i,
  },
  {
    title: "all three inputs",
    args: {
      snoozedUntil: "2026-03-08T13:00:00.000Z",
      snoozeForMinutes: 10,
      snoozeUntilLocal: "2026-03-08T09:00",
    },
    message: /exactly one|one of/i,
  },
  {
    title: "zone with absolute input",
    args: { snoozedUntil: "2026-03-08T13:00:00.000Z", timeZone: "Europe/Madrid" },
    message: /timeZone.*snoozeUntilLocal|zone.*local/i,
  },
  {
    title: "zone with relative input",
    args: { snoozeForMinutes: 10, timeZone: "Europe/Madrid" },
    message: /timeZone.*snoozeUntilLocal|zone.*local/i,
  },
  {
    title: "unknown IANA zone",
    args: { snoozeUntilLocal: "2026-03-08T09:00", timeZone: "Mars/Olympus" },
    message: /zone|IANA/i,
  },
  {
    title: "malformed local input",
    args: { snoozeUntilLocal: "tomorrow at nine" },
    message: /YYYY-MM-DDTHH:MM|local time/i,
  },
  {
    title: "impossible local date",
    args: { snoozeUntilLocal: "2026-02-30T09:00" },
    message: /date|local time/i,
  },
  {
    title: "past absolute input",
    args: { snoozedUntil: "2026-03-06T13:00:00.000Z" },
    message: /past|future/i,
  },
  {
    title: "past local input",
    args: { snoozeUntilLocal: "2026-03-06T09:00", timeZone: "UTC" },
    message: /past|future/i,
  },
] as const;

it.effect.each(refusals)(
  "snooze-zone AC3 spec: MCP refuses $title with a readable error and no dispatch",
  (refusal) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(
        DateTime.toEpochMillis(DateTime.makeUnsafe("2026-03-07T18:15:00.000Z")),
      );
      const harness = yield* makeOrganizeServer(McpServer);
      const result = yield* harness.call({ action: "snooze", threadId: TARGET, ...refusal.args });
      expect(harness.commands).toEqual([]);
      expect(result.isError).toBe(true);
      const text = result.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
      expect(text).toMatch(refusal.message);
    }),
);

it.effect(
  "snooze-zone AC7 spec: MCP advertises three snooze inputs with at most two added sentences",
  () =>
    Effect.gen(function* () {
      const { server } = yield* makeOrganizeServer(McpServer);
      const tool = server.tools.find(({ tool }) => tool.name === "t3_thread_organize")?.tool;
      expect(tool).toBeDefined();
      for (const name of ["snoozeForMinutes", "snoozeUntilLocal", "timeZone"]) {
        expect(tool?.inputSchema.properties).toHaveProperty(name);
        expect(tool?.description).toContain(name);
      }
      const description = tool?.description ?? "";
      // The base has five sentences. Phase 3 permits at most two more.
      expect(
        description.split(/\.(?:\s|$)/).filter((sentence) => sentence.trim()).length,
      ).toBeLessThanOrEqual(7);
    }),
);

it.effect(
  "snooze-zone guard: an absolute-only MCP snooze still dispatches its exact timestamp",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(
        DateTime.toEpochMillis(DateTime.makeUnsafe("2026-03-07T18:15:00.000Z")),
      );
      const harness = yield* makeOrganizeServer(McpServer);
      const result = yield* harness.call({
        action: "snooze",
        threadId: TARGET,
        snoozedUntil: "2026-03-08T13:00:00Z",
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ sequence: 17 });
      expect(harness.commands).toEqual([
        expect.objectContaining({
          type: "thread.snooze",
          threadId: TARGET,
          snoozedUntil: "2026-03-08T13:00:00Z",
        }),
      ]);
    }),
);

it.effect("snooze-zone guard: the other MCP organize actions retain their command semantics", () =>
  Effect.gen(function* () {
    const harness = yield* makeOrganizeServer(McpServer);
    for (const action of [
      "pin",
      "unpin",
      "unsnooze",
      "settle",
      "unsettle",
      "archive",
      "unarchive",
      "mark_unread",
    ]) {
      const result = yield* harness.call({ action, threadId: TARGET });
      expect(result.isError).not.toBe(true);
    }
    expect(harness.commands.map(({ commandId: _id, ...command }) => command)).toEqual([
      { type: "thread.pin", threadId: TARGET },
      { type: "thread.unpin", threadId: TARGET },
      { type: "thread.unsnooze", threadId: TARGET, reason: "user" },
      { type: "thread.unsettle", threadId: TARGET, reason: "user" },
      { type: "thread.archive", threadId: TARGET },
      { type: "thread.unarchive", threadId: TARGET },
      { type: "thread.mark-unread", threadId: TARGET },
    ]);
    expect(harness.settles).toEqual([
      expect.objectContaining({ threadId: TARGET, byOwnAgent: false }),
    ]);
  }),
);

it.effect(
  "snooze-zone rework P2-2 MCP: relative and absolute wake times use the setting zone",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-03-07T18:15:00Z")));
      const harness = yield* makeOrganizeServer(McpServer, { snoozeTimeZone: "America/New_York" });
      for (const [input, wake] of [
        [{ snoozeForMinutes: 90 }, "2026-03-07T14:45"],
        [{ snoozedUntil: "2026-03-08T13:00:00Z" }, "2026-03-08T09:00"],
      ] as const) {
        const result = yield* harness.call({ action: "snooze", threadId: TARGET, ...input });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          snoozedUntilLocal: wake,
          timeZone: "America/New_York",
          timeZoneSource: "setting",
        });
      }
    }),
);
