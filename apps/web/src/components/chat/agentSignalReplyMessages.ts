import type { TimelineEntry } from "../../session-logic";

/**
 * Mesura: `t3_thread_signal` is this fork's tool. Agents often write their question, signal
 * `needs_input`, then close with one line, and the turn fold shows only that last line. Every
 * provider names the tool with its own prefix (`mcp__t3-code__…`, `t3-code.…`).
 */
const AGENT_SIGNAL_TOOL = "t3_thread_signal";
const MESURA_TOOL_SERVER = /t3[-_]code/;

const isAgentSignalToolName = (toolName: string) =>
  toolName === AGENT_SIGNAL_TOOL ||
  (toolName.endsWith(AGENT_SIGNAL_TOOL) && MESURA_TOOL_SERVER.test(toolName));

function isAgentSignalOrReasoning(entry: TimelineEntry): boolean {
  if (entry.kind !== "work") return false;
  const item = entry.entry.structuredPayload;
  if (item?.type === "reasoning") return true;
  return (
    item?.type === "dynamic_tool" && item.toolName !== null && isAgentSignalToolName(item.toolName)
  );
}

/**
 * The assistant messages that end a reply before its terminal message: the terminal message is
 * reached from them through agent signals and reasoning only. The turn fold keeps them visible.
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
    for (let index = terminalIndex - 1; index >= 0; index -= 1) {
      const entry = timelineEntries[index]!;
      if (isAgentSignalOrReasoning(entry)) {
        crossedSignal ||= entry.kind === "work" && entry.entry.itemType !== "reasoning";
        continue;
      }
      const isSameReply =
        entry.kind === "message" &&
        entry.message.role === "assistant" &&
        entry.message.runId === terminal.message.runId;
      if (!isSameReply || !crossedSignal) break;
      replyMessageIds.add(entry.id);
    }
  }
  return replyMessageIds;
}
