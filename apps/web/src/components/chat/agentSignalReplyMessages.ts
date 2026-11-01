import { resolveT3McpToolName } from "@t3tools/shared/t3McpToolPresentation";

import type { TimelineEntry } from "../../session-logic";

/**
 * Mesura: `t3_thread_signal` is this fork's tool. Agents often write their question, signal
 * `needs_input`, then close with one line, and the turn fold shows only that last line.
 */
const AGENT_SIGNAL_TOOL = "t3_thread_signal";
/** OpenCode names its Mesura server per thread: `t3-code-<thread>_t3_thread_signal`. */
const OPENCODE_THREAD_SIGNAL = /^t3-code-[\w-]+_t3_thread_signal$/;

/**
 * The shared parser resolves bare and OpenCode names only for tools in upstream's registry, which
 * lacks this fork's tool; registering it would touch three upstream files, so both forms are here.
 */
const isAgentSignalToolName = (toolName: string) =>
  toolName === AGENT_SIGNAL_TOOL ||
  OPENCODE_THREAD_SIGNAL.test(toolName) ||
  resolveT3McpToolName(toolName) === AGENT_SIGNAL_TOOL;

function isAgentSignal(entry: TimelineEntry): boolean {
  if (entry.kind !== "work") return false;
  const item = entry.entry.structuredPayload;
  return (
    item?.type === "dynamic_tool" && item.toolName !== null && isAgentSignalToolName(item.toolName)
  );
}

const isReasoning = (entry: TimelineEntry) =>
  entry.kind === "work" && entry.entry.structuredPayload?.type === "reasoning";

/**
 * The assistant messages of a reply that an agent signal splits: walking back from the terminal
 * message through assistant messages, signals and reasoning only, every message is kept once a
 * signal lies between it and the terminal message. The turn fold keeps them visible.
 */
export function agentSignalReplyMessageIds(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  terminalAssistantMessageIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const replyMessageIds = new Set<string>();
  for (const [terminalIndex, terminal] of timelineEntries.entries()) {
    if (terminal.kind !== "message" || !terminalAssistantMessageIds.has(terminal.message.id)) {
      continue;
    }
    let crossedSignal = false;
    let messagesAfterSignal: string[] = [];
    for (let index = terminalIndex - 1; index >= 0; index -= 1) {
      const entry = timelineEntries[index]!;
      if (isReasoning(entry)) continue;
      if (isAgentSignal(entry)) {
        crossedSignal = true;
        continue;
      }
      const isSameReply =
        entry.kind === "message" &&
        entry.message.role === "assistant" &&
        entry.message.runId === terminal.message.runId;
      if (!isSameReply) break;
      if (!crossedSignal) {
        messagesAfterSignal.push(entry.id);
        continue;
      }
      for (const id of messagesAfterSignal) replyMessageIds.add(id);
      messagesAfterSignal = [];
      replyMessageIds.add(entry.id);
    }
  }
  return replyMessageIds;
}
