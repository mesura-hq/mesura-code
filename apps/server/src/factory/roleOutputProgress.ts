/**
 * Live progress of one Software Factory role, read line by line from its output:
 * a Claude `--output-format stream-json` file or a Codex `exec --json` events file.
 * Only counters are kept, so a role's output of megabytes costs a few bytes.
 *
 * @module roleOutputProgress
 */

export interface RoleOutputProgress {
  readonly toolCalls: number;
  readonly lastTool: string | null;
  readonly lastActivityAt: string | null;
  /** Codex reports an item when it starts and when it completes; each item counts once. */
  readonly countedItemIds: ReadonlySet<string>;
}

export const emptyRoleOutputProgress: RoleOutputProgress = {
  toolCalls: 0,
  lastTool: null,
  lastActivityAt: null,
  countedItemIds: new Set(),
};

/** Codex items that are the model talking, not a tool acting. */
const CODEX_MESSAGE_ITEM_TYPES = new Set(["agent_message", "reasoning", "todo_list", "error"]);

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function codexToolName(item: JsonObject): string {
  if (typeof item.tool === "string") {
    return typeof item.server === "string" ? `${item.server}.${item.tool}` : item.tool;
  }
  return typeof item.type === "string" ? item.type : "tool";
}

/**
 * Folds one output line. `readAt` stands in for the activity time where the line
 * carries none, as Codex lines do. A line that is not JSON changes nothing.
 */
export function foldRoleOutputLine(
  progress: RoleOutputProgress,
  line: string,
  readAt: string,
): RoleOutputProgress {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return progress;
  }
  if (!isObject(value)) return progress;

  // Claude stream-json: an assistant message carries its tool calls as `tool_use` blocks.
  if (value.type === "assistant" && isObject(value.message)) {
    const content = Array.isArray(value.message.content) ? value.message.content : [];
    const toolUses = content.filter(
      (block): block is JsonObject => isObject(block) && block.type === "tool_use",
    );
    const lastToolUse = toolUses.at(-1);
    return {
      ...progress,
      toolCalls: progress.toolCalls + toolUses.length,
      lastTool:
        lastToolUse !== undefined && typeof lastToolUse.name === "string"
          ? lastToolUse.name
          : progress.lastTool,
      lastActivityAt: typeof value.timestamp === "string" ? value.timestamp : readAt,
    };
  }

  // Codex events: a tool item arrives as `item.started`, `item.completed`, or both.
  if ((value.type === "item.started" || value.type === "item.completed") && isObject(value.item)) {
    const item = value.item;
    const id = typeof item.id === "string" ? item.id : null;
    const isTool = typeof item.type === "string" && !CODEX_MESSAGE_ITEM_TYPES.has(item.type);
    if (!isTool || id === null || progress.countedItemIds.has(id)) {
      return { ...progress, lastActivityAt: readAt };
    }
    return {
      toolCalls: progress.toolCalls + 1,
      lastTool: codexToolName(item),
      lastActivityAt: readAt,
      countedItemIds: new Set(progress.countedItemIds).add(id),
    };
  }

  return typeof value.type === "string" ? { ...progress, lastActivityAt: readAt } : progress;
}
