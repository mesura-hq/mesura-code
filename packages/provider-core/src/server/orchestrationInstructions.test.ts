// Entry point: `T3_CODE_ORCHESTRATION_SECTIONS` and `T3_CODE_ORCHESTRATION_INSTRUCTIONS`, the
// text every provider adapter injects into its agent's instructions.
import { assert, describe, expect, it } from "@effect/vitest";

import {
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_SECTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPrompt,
  t3OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("T3 device instructions", () => {
  it("route device work through device_open and give Claude the line that loads the tools", () => {
    for (const intent of ["`device_list`", "`device_open`", "`agent-device`", "ssh", "`hostId`"]) {
      assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, intent);
    }
    assert.notInclude(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, "ToolSearch");
    const loadLine =
      " Load them with ToolSearch `select:mcp__t3-code__device_list,mcp__t3-code__device_open,mcp__t3-code__device_screenshot,mcp__t3-code__device_close`.";
    assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH, loadLine);
    assert.equal(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH.replace(loadLine, ""),
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
    );
  });

  it("open the app before the returned command's snapshots, screenshots and input", () => {
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "its snapshots, screenshots and input need `open <app>` first,",
    );
  });

  it("keep the failure rule from taking over or closing a session another thread holds", () => {
    // agent-device's DEVICE_IN_USE advice is to rerun with the owner's --session or close it first.
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "follow its advice once, but never reuse or close another session; if it still fails,",
    );
  });

  it("reach OpenCode and Cursor only when the session holds device access", () => {
    assert.include(t3OrchestrationSystemPrompt(true, true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(t3OrchestrationSystemPrompt(true, false), "## Mesura Code devices");
    assert.isUndefined(t3OrchestrationSystemPrompt(false, true));

    const firstRun = (hasDeviceTools: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools,
        orchestrationDelivered: false,
        deviceInstructionsDelivered: false,
      });
    assert.include(firstRun(true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(firstRun(false), "## Mesura Code devices");

    const laterRun = (deviceInstructionsDelivered: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools: true,
        orchestrationDelivered: true,
        deviceInstructionsDelivered,
      });
    assert.include(laterRun(false), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(laterRun(false), T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(laterRun(true), "Check the login screen.");
  });

  it("reach ACP agents again when device access changes mid-thread", () => {
    const state = { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: false } as const;
    const withDevices = t3AcpPromptWithInstructions({
      prompt: "Check the login screen.",
      state: { ...state, hasDeviceTools: true },
      previousState: state,
    });
    assert.include(withDevices, T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.equal(
      t3AcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );
    assert.notInclude(
      t3AcpPromptWithInstructions({ prompt: "Hi.", state }),
      "## Mesura Code devices",
    );
  });
});

const signalSection = () =>
  T3_CODE_ORCHESTRATION_SECTIONS.find((section) => section.includes("t3_thread_signal"));

// Snapshot of the injected wording: the agent's behaviour is this text, so a change to it is a
// deliberate edit here too, never a side effect.
const SIGNAL_SECTION_SNAPSHOT = `### Signal the user, and close only with permission

Mark this thread with \`t3_thread_signal\` so the user sees where it stands without opening it:

- \`needs_input\`: call it before you end a turn with a question or a decision only the user can make, and put that question in \`note\` in a few words. Call it before you write your final reply, and make the question part of that final reply: the chat folds what you write before your last tool call into a collapsed group. Structured questions and approvals already mark the thread; this is for questions you ask in your reply.
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

describe("orchestration instructions: compact and continue", () => {
  const compactSection = () =>
    T3_CODE_ORCHESTRATION_SECTIONS.find((section) =>
      section.includes("t3_thread_compact_and_continue"),
    );

  it("compact-and-continue instructions spec: a rule says when and how to call the tool", () => {
    const section = compactSection();
    expect(section, "no section mentions t3_thread_compact_and_continue").toBeDefined();
    const text = section ?? "";
    // Only on the user's request.
    expect(text).toMatch(/only when the user's latest message asks/i);
    // The work comes first, and a failed or incomplete job never compacts.
    expect(text).toMatch(/finish and verify/i);
    expect(text).toMatch(/fail/i);
    expect(text).toMatch(/incomplete/i);
    // The next request travels verbatim in `next`.
    expect(text).toMatch(/quote/i);
    expect(text).toContain("`next`");
    // The turn ends right after the call.
    expect(text).toMatch(/end (the|your) turn/i);
    expect(text).toMatch(/short reply|one-line reply/i);
  });
});

it("snooze-zone AC6 spec: the injected snooze rule resolves user times through the tool", () => {
  const section = T3_CODE_ORCHESTRATION_SECTIONS.find((text) => /^### Snooze\b/m.test(text));
  expect(section, "the orchestration instructions need a Snooze rule").toBeDefined();
  const text = section ?? "";
  expect(text).toContain("t3_thread_organize");
  expect(text).toMatch(/snoozeForMinutes[^\n.]*relative/i);
  expect(text).toMatch(/snoozeUntilLocal[^\n.]*clock/i);
  expect(text).toMatch(/timeZone[^\n.]*only when the user names a zone/i);
  expect(text).toMatch(/never[^\n.]*convert[^\n.]*UTC|do not[^\n.]*convert[^\n.]*UTC/i);
  expect(text).toMatch(/report[^\n.]*wake time[^\n.]*zone/i);
  expect(text).toContain("wake time from `snoozedUntilLocal`");
  expect(T3_CODE_ORCHESTRATION_INSTRUCTIONS).toContain(text);
});

it("snooze-day AC7 spec: the snooze rule sends relative days to snoozeDay and dates to snoozeUntilLocal", () => {
  const section = T3_CODE_ORCHESTRATION_SECTIONS.find((text) => /^### Snooze\b/m.test(text)) ?? "";
  const sentences = section.split(/\.(?:\s|$)/);
  const daySentence = sentences.find((sentence) => sentence.includes("`snoozeDay`"));
  expect(daySentence, "the Snooze rule needs a snoozeDay sentence").toBeDefined();
  expect(daySentence).toContain("`snoozeAt`");
  for (const word of [/today/i, /tomorrow/i, /weekday/i]) expect(daySentence).toMatch(word);
  expect(
    sentences.some((sentence) =>
      /`snoozeUntilLocal`[^\n]*only[^\n]*date|only[^\n]*date[^\n]*`snoozeUntilLocal`/i.test(
        sentence,
      ),
    ),
    "the Snooze rule keeps snoozeUntilLocal for an explicit date only",
  ).toBe(true);
  expect(T3_CODE_ORCHESTRATION_INSTRUCTIONS).toContain(section);
});
