/**
 * Entry point: `deriveMessagesTimelineRows`. The entries mirror the 2026-10-31 turn in which a
 * Claude agent wrote three questions, called `t3_thread_signal`, then closed with one line.
 */
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "../../session-logic";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";

const at = (second: number) => `2026-10-31T21:11:${String(second).padStart(2, "0")}.000Z`;

const message = (id: string, second: number, role: "user" | "assistant", text = id) =>
  ({
    id: `${id}-entry`,
    kind: "message",
    createdAt: at(second),
    message: {
      id: id as never,
      role,
      text,
      runId: role === "assistant" ? ("turn-1" as never) : null,
      createdAt: at(second),
      updatedAt: at(second),
      streaming: false,
    },
  }) satisfies TimelineEntry;

const work = (id: string, second: number, structuredPayload: object) =>
  ({
    id: `${id}-entry`,
    kind: "work",
    createdAt: at(second),
    entry: {
      id,
      createdAt: at(second),
      runId: "turn-1" as never,
      label: id,
      tone: "tool",
      itemType: (structuredPayload as { type: never }).type,
      toolLifecycleStatus: "completed",
      structuredPayload: structuredPayload as never,
    },
  }) satisfies TimelineEntry;

const signal = (id: string, second: number, toolName: string) =>
  work(id, second, { type: "dynamic_tool", toolName });
const reasoning = (id: string, second: number) => work(id, second, { type: "reasoning" });
const command = (id: string, second: number) => work(id, second, { type: "command_execution" });

function collapsedRowIds(timelineEntries: ReadonlyArray<TimelineEntry>) {
  return deriveMessagesTimelineRows({
    timelineEntries,
    isWorking: false,
    activeTurnStartedAt: null,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
  }).map((row) => row.id);
}

describe("a reply split by an agent signal", () => {
  it.each([
    ["Claude", "mcp__t3-code__t3_thread_signal"],
    ["Codex", "t3-code.t3_thread_signal"],
    ["OpenCode", "t3-code-thread_opencode2-adapter_t3_thread_signal"],
    ["bare-named", "t3_thread_signal"],
  ])(
    "keeps the questions visible when a %s agent signals before its closing line",
    (_, toolName) => {
      expect(
        collapsedRowIds([
          message("user", 0, "user"),
          command("read-files", 10),
          message("questions", 16, "assistant", "1. Which scope? 2. Which date? 3. Who?"),
          signal("signal", 20, toolName),
          reasoning("thinking", 24),
          message("closing", 28, "assistant", "I need your answers to those three questions."),
        ]),
      ).toEqual(["user-entry", "turn-fold:turn-1", "questions-entry", "closing-entry"]);
    },
  );

  it("keeps every message joined to the closing line through signals", () => {
    expect(
      collapsedRowIds([
        message("user", 0, "user"),
        command("read-files", 10),
        message("summary", 14, "assistant"),
        message("questions", 16, "assistant"),
        signal("signal", 20, "mcp__t3-code__t3_thread_signal"),
        message("closing", 28, "assistant"),
      ]),
    ).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "summary-entry",
      "questions-entry",
      "closing-entry",
    ]);
  });

  it("still folds a message that a command separates from the closing line", () => {
    expect(
      collapsedRowIds([
        message("user", 0, "user"),
        message("progress", 8, "assistant"),
        command("run-tests", 10),
        signal("signal", 20, "mcp__t3-code__t3_thread_signal"),
        message("closing", 28, "assistant"),
      ]),
    ).toEqual(["user-entry", "turn-fold:turn-1", "closing-entry"]);
  });

  it("still folds a message that only reasoning separates from the closing line", () => {
    expect(
      collapsedRowIds([
        message("user", 0, "user"),
        command("read-files", 4),
        message("progress", 8, "assistant"),
        reasoning("thinking", 10),
        message("closing", 28, "assistant"),
      ]),
    ).toEqual(["user-entry", "turn-fold:turn-1", "closing-entry"]);
  });

  it("keeps the questions and every later message when the signal comes right after the questions", () => {
    expect(
      collapsedRowIds([
        message("user", 0, "user"),
        command("read-files", 10),
        message("questions", 16, "assistant"),
        signal("signal", 20, "mcp__t3-code__t3_thread_signal"),
        message("continuation", 24, "assistant"),
        message("closing", 28, "assistant"),
      ]),
    ).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "questions-entry",
      "continuation-entry",
      "closing-entry",
    ]);
  });

  it.each([
    "mcp__other__t3_thread_signal",
    "mcp__other-t3-code__t3_thread_signal",
    "mcp__not-t3-code__t3_thread_signal",
    "mcp__t3-code__not_t3_thread_signal",
    "t3-code.t3_thread_signal_v2",
  ])("does not treat %s as a signal", (toolName) => {
    expect(
      collapsedRowIds([
        message("user", 0, "user"),
        message("progress", 8, "assistant"),
        signal("lookalike", 20, toolName),
        message("closing", 28, "assistant"),
      ]),
    ).toEqual(["user-entry", "turn-fold:turn-1", "closing-entry"]);
  });
});
