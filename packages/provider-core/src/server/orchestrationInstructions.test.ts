// Entry point: `T3_CODE_ORCHESTRATION_SECTIONS` and `T3_CODE_ORCHESTRATION_INSTRUCTIONS`, the
// text every provider adapter injects into its agent's instructions.
import { describe, expect, it } from "vite-plus/test";

import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_SECTIONS,
} from "./orchestrationInstructions.ts";

const signalSection = () =>
  T3_CODE_ORCHESTRATION_SECTIONS.find((section) => section.includes("t3_thread_signal"));

// Snapshot of the injected wording: the agent's behaviour is this text, so a change to it is a
// deliberate edit here too, never a side effect.
const SIGNAL_SECTION_SNAPSHOT = `### Signal the user, and close only with permission

Mark this thread with \`t3_thread_signal\` so the user sees where it stands without opening it:

- \`needs_input\`: call it before you end a turn with a question or a decision only the user can make, and put that question in \`note\` in a few words. Structured questions and approvals already mark the thread; this is for questions you ask in your reply.
- \`ready_to_close\`: call it only when you judge that the thread's purpose (the goal the user gave this thread) is fulfilled and no background command, subagent, delegated task, or watch is still running. Do not call it just because a turn or one step ended. The user may give the thread a new purpose afterwards.
- \`clear\`: remove a mark that no longer holds.

The user's next message clears the mark, and a new turn clears \`ready_to_close\`.

Settle this thread with \`t3_thread_organize\` action \`settle\` only when the user explicitly allowed you to close it in a message since it was last reopened; one permission covers one close. Otherwise, leave closing to the user. Signal \`ready_to_close\` only when the thread's purpose is fulfilled under the conditions above.`;

describe("orchestration instructions: thread signal", () => {
  it("signal instructions spec: one section describes both signal states", () => {
    const section = signalSection();
    expect(section, "no section mentions t3_thread_signal").toBeDefined();
    expect(section).toMatch(/needs_input/);
    expect(section).toMatch(/ready_to_close/);
    expect(section).toMatch(/question|decision/i);
  });

  it("signal instructions spec: settling needs the user's explicit permission in a message", () => {
    const section = signalSection() ?? "";
    expect(section).toMatch(/t3_thread_organize/);
    expect(section).toMatch(/settle/);
    expect(section).toMatch(/explicit/i);
    expect(section).toMatch(/message/i);
    expect(section).toContain("Otherwise, leave closing to the user.");
    expect(section).toContain("Do not call it just because a turn or one step ended.");
    expect(section).toContain("The user may give the thread a new purpose afterwards.");
  });

  it("signal instructions snapshot: the signal section's exact wording", () => {
    expect(signalSection()).toBe(SIGNAL_SECTION_SNAPSHOT);
  });

  it("signal instructions guard: every section stays under Codex's 4,000-byte entry limit", () => {
    for (const section of T3_CODE_ORCHESTRATION_SECTIONS) {
      expect(new TextEncoder().encode(section).byteLength).toBeLessThan(4_000);
    }
  });

  it("signal instructions guard: the joined instructions carry every section", () => {
    for (const section of T3_CODE_ORCHESTRATION_SECTIONS) {
      expect(T3_CODE_ORCHESTRATION_INSTRUCTIONS).toContain(section);
    }
  });
});
