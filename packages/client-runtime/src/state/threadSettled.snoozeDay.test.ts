// @effect-diagnostics globalDate:off -- Tests exercise local calendar snooze boundaries.
// Entry point: `resolveSnoozePresets`, the function the sidebar snooze menu calls.
import { describe, expect, it, vi } from "vite-plus/test";

const sharedDayRule = vi.hoisted(() => ({ calls: [] as Array<[string, number]> }));

vi.mock("@t3tools/contracts", async (original) => {
  const contracts = await original<typeof import("@t3tools/contracts")>();
  return {
    ...contracts,
    snoozeDaysAhead: (...args: Parameters<typeof contracts.snoozeDaysAhead>) => {
      sharedDayRule.calls.push(args);
      return contracts.snoozeDaysAhead(...args);
    },
  };
});

import { resolveSnoozePresets } from "./threadSettled.ts";

describe("snooze-day AC6 spec", () => {
  it("snooze-day AC6 spec: the preset day count comes from the contracts day rule", () => {
    sharedDayRule.calls.length = 0;
    // Wednesday 20:00 local.
    const now = new Date(2026, 3, 8, 20, 0, 0, 0);
    const presets = resolveSnoozePresets(now, {
      presets: [
        { kind: "at", day: "tomorrow", time: "09:00" },
        { kind: "at", day: "friday", time: "17:00" },
      ],
    });
    expect(presets.map((preset) => preset.label)).toEqual(["Tomorrow", "Friday"]);
    expect(sharedDayRule.calls).toEqual([
      ["tomorrow", now.getDay()],
      ["friday", now.getDay()],
    ]);
  });
});
