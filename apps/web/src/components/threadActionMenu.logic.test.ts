import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive while the thread is running", () => {
    const archiveItem = buildThreadActionMenuItems({ ...baseState, isRunning: true }).find(
      (item) => item.id === "archive",
    );
    expect(archiveItem?.disabled).toBe(true);
  });
});

// Phase 4 fence: the header menu and the sidebar row both render this list, so the saved voice
// conversations entry and its capability gate exist once.
describe("buildThreadActionMenuItems voice conversations", () => {
  const withVoiceHistory = (voiceHistory: boolean): ThreadActionMenuState => ({
    ...baseState,
    supports: { ...baseState.supports, voiceHistory },
  });
  const voiceEntries = (state: ThreadActionMenuState) =>
    buildThreadActionMenuItems(state).filter((item) => /voice conversations/i.test(item.label));

  it("thread menu offers saved voice conversations when the environment records voice history", () => {
    const entries = voiceEntries(withVoiceHistory(true));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.disabled).not.toBe(true);
    expect(entries[0]?.destructive).not.toBe(true);
  });

  it("thread menu hides voice conversations on environments without voice history", () => {
    expect(voiceEntries(withVoiceHistory(false))).toEqual([]);
    expect(voiceEntries(baseState)).toEqual([]);
  });

  it("thread menu keeps delete last with voice conversations present", () => {
    expect(buildThreadActionMenuItems(withVoiceHistory(true)).at(-1)?.id).toBe("delete");
  });
});

describe("buildThreadActionMenuItems voice conversations without operate scope", () => {
  it("thread menu keeps saved voice conversations readable without operate scope", () => {
    const entry = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      supports: { ...baseState.supports, voiceHistory: true },
    }).find((item) => item.id === "voice-history");
    expect(entry).toBeDefined();
    expect(entry?.disabled).not.toBe(true);
  });
});
