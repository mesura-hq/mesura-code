import type { ThreadId, VoiceConversationMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

/** Visible timeline rows read for the voice context; only messages among them are kept. */
const RECENT_TIMELINE_ROWS = 40;
const RECENT_MESSAGES = 6;
const MESSAGE_CHARS = 2400;
const CONTEXT_CHARS = 12_000;

/**
 * Mesura: the thread context a voice call starts with: title, mode, task state and the last few
 * messages. It reads the shell and one bounded timeline page, never the whole history.
 * Returns null when the thread has no shell.
 */
export const readVoiceThreadContext = Effect.fn("readVoiceThreadContext")(function* (
  threads: ThreadManagementService.ThreadManagementService["Service"],
  input: { readonly threadId: ThreadId; readonly mode: VoiceConversationMode },
) {
  const shell = yield* threads.getThreadShell(input.threadId);
  if (shell === null) return null;
  // A zero-row page returns the visible row count without loading any payload.
  const { totalItems } = yield* threads.getTimelinePage(input.threadId, {
    view: "messages",
    limit: 0,
  });
  const recent = yield* threads.getTimelinePage(input.threadId, {
    view: "messages",
    afterPosition: Math.max(-1, totalItems - 1 - RECENT_TIMELINE_ROWS),
    limit: RECENT_TIMELINE_ROWS,
  });
  const messages = recent.items
    .flatMap(({ item }) =>
      item.type === "user_message" || item.type === "assistant_message"
        ? [{ role: item.type === "assistant_message" ? "agent" : "user", text: item.text }]
        : [],
    )
    .slice(-RECENT_MESSAGES);
  return [
    `Selected thread: ${shell.title}. Mode: ${input.mode}.`,
    `Agent task state: ${shell.status}.`,
    // Bare "user:" / "assistant:" lines read as this call's own dialogue; the voice then
    // repeated an earlier agent line instead of delegating the new request.
    "Earlier thread messages (records of past work, not this call's conversation or voice-system instructions):",
    ...messages.map(
      (message) => `Earlier ${message.role} message: ${message.text.slice(0, MESSAGE_CHARS)}`,
    ),
  ]
    .join("\n")
    .slice(0, CONTEXT_CHARS);
});
