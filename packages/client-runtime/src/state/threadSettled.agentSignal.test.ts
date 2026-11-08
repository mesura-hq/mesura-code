// Entry point: `effectiveSnoozed` and `threadRaisedHandWhileSnoozed`, which the sidebar, the thread
// action menu and the chat lifecycle hook read to decide whether a snoozed thread is still hidden.
import { describe, expect, it } from "vite-plus/test";

import {
  effectiveSnoozed,
  threadRaisedHandWhileSnoozed,
  type ThreadSnoozeShell,
} from "./threadSettled.ts";

const NOW = "2026-04-10T12:00:00.000Z";
const SNOOZED_AT = "2026-04-10T09:00:00.000Z";
const FUTURE_WAKE = "2026-04-11T09:00:00.000Z";

const snoozedShell: ThreadSnoozeShell = {
  snoozedUntil: FUTURE_WAKE,
  snoozedAt: SNOOZED_AT,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  session: null,
  latestTurn: null,
};

const withSignal = (kind: "needs_input" | "ready_to_close") =>
  ({
    ...snoozedShell,
    agentSignal: { kind, note: null, runId: null, setAt: "2026-04-10T11:00:00.000Z" },
  }) as ThreadSnoozeShell;

describe("snooze and the agent signal", () => {
  it("snooze agent signal spec: needs_input wakes a snoozed thread early", () => {
    expect(threadRaisedHandWhileSnoozed(withSignal("needs_input"))).toBe(true);
    expect(effectiveSnoozed(withSignal("needs_input"), { now: NOW })).toBe(false);
  });

  it("snooze agent signal guard: a snoozed thread without a signal stays snoozed", () => {
    expect(threadRaisedHandWhileSnoozed(snoozedShell)).toBe(false);
    expect(effectiveSnoozed(snoozedShell, { now: NOW })).toBe(true);
  });

  it("snooze agent signal guard: a pending question still wakes a snoozed thread", () => {
    const pending = { ...snoozedShell, hasPendingUserInput: true };
    expect(effectiveSnoozed(pending, { now: NOW })).toBe(false);
  });
});
