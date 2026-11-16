// Thread attention phase 6: the dock's policy, as pure functions in `pinnedActionDock.logic.ts`.
// What only a browser shows is in `PinnedActionDock.browser.test.tsx`.
import type { ThreadPendingApproval } from "@t3tools/client-runtime/state/thread-requests";
import { RuntimeRequestId, type ThreadAgentSignal } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  PHONE_DOCK_EXPANDED_LIMIT,
  derivePinnedActionDockItems,
  layoutPinnedActionDock,
  pinnedActionDockCloseAction,
  type PinnedActionDockInput,
  type PinnedActionDockItem,
} from "./pinnedActionDock.logic";

const approval = (id: string, createdAt: string): ThreadPendingApproval => ({
  requestId: RuntimeRequestId.make(id),
  requestKind: "command",
  createdAt,
  detail: "pnpm install",
  responseCapability: "live",
});

const signal = (setAt: string): ThreadAgentSignal => ({
  kind: "needs_input",
  note: "Pick the migration order",
  runId: null,
  setAt,
});

const input = (overrides: Partial<PinnedActionDockInput> = {}): PinnedActionDockInput => ({
  approvals: [],
  ...overrides,
});

const kinds = (items: ReadonlyArray<PinnedActionDockItem>) => items.map((item) => item.kind);

describe("phase6 dock AC4: every pending approval has an X that declines it", () => {
  it("phase6 dock AC4 the X on an approval sends the decline decision, not cancel", () => {
    const [item] = derivePinnedActionDockItems(
      input({ approvals: [approval("approval-1", "2026-10-24T10:00:00.000Z")] }),
    );
    expect(item!.kind).toBe("approval");
    expect(pinnedActionDockCloseAction(item!)).toEqual({
      type: "respond-approval",
      requestId: "approval-1",
      decision: "decline",
    });
  });
});

describe("phase6 dock AC5: agent signals stay outside the dock", () => {
  it.each(["needs_input", "ready_to_close"] as const)("the dock ignores a %s signal", (kind) => {
    const sources = {
      ...input({ approvals: [approval("approval-1", "2026-10-24T10:00:00.000Z")] }),
      agentSignal: { ...signal("2026-10-24T10:03:00.000Z"), kind },
    };
    expect(kinds(derivePinnedActionDockItems(sources))).toEqual(["approval"]);
  });
});

describe("phase6 dock AC6: newest first, at most two expanded at phone width", () => {
  const several = input({
    approvals: [
      approval("approval-1", "2026-10-24T10:00:00.000Z"),
      approval("approval-3", "2026-10-24T10:02:00.000Z"),
      approval("approval-2", "2026-10-24T10:01:00.000Z"),
    ],
  });
  const requestIds = (items: ReadonlyArray<PinnedActionDockItem>) =>
    items.map((item) => item.approval.requestId);

  it("phase6 dock AC6 stacks the items newest first", () => {
    expect(requestIds(derivePinnedActionDockItems(several))).toEqual([
      "approval-3",
      "approval-2",
      "approval-1",
    ]);
  });

  it("phase6 dock AC6 expands the two newest at phone width and collapses the rest to one line", () => {
    const layout = layoutPinnedActionDock(derivePinnedActionDockItems(several), {
      phoneWidth: true,
      expandedKeys: new Set(),
    });
    expect(PHONE_DOCK_EXPANDED_LIMIT).toBe(2);
    expect(layout.map((entry) => [entry.item.approval.requestId, entry.expanded])).toEqual([
      ["approval-3", true],
      ["approval-2", true],
      ["approval-1", false],
    ]);
  });

  it("phase6 dock AC6 a tapped collapsed item expands and the phone limit still holds", () => {
    const items = derivePinnedActionDockItems(several);
    const approvalKey = items.at(-1)!.key;
    const layout = layoutPinnedActionDock(items, {
      phoneWidth: true,
      expandedKeys: new Set([approvalKey]),
    });
    expect(layout.find((entry) => entry.item.key === approvalKey)?.expanded).toBe(true);
    expect(layout.filter((entry) => entry.expanded)).toHaveLength(PHONE_DOCK_EXPANDED_LIMIT);
  });

  it("phase6 dock AC6 keeps every item expanded at desktop width", () => {
    const layout = layoutPinnedActionDock(derivePinnedActionDockItems(several), {
      phoneWidth: false,
      expandedKeys: new Set(),
    });
    expect(layout.every((entry) => entry.expanded)).toBe(true);
  });

  it("phase6 dock AC6 gives every item a key that is unique and stable across derivations", () => {
    const first = derivePinnedActionDockItems(several).map((item) => item.key);
    const second = derivePinnedActionDockItems(several).map((item) => item.key);
    expect(new Set(first).size).toBe(first.length);
    expect(second).toEqual(first);
  });
});

describe("phase6 dock AC7: every X is labelled with the item it closes", () => {
  it("phase6 dock AC7 each close label names its item", () => {
    const items = derivePinnedActionDockItems(
      input({ approvals: [approval("approval-1", "2026-10-24T10:00:00.000Z")] }),
    );
    expect(items.map((item) => item.closeLabel)).toEqual([
      expect.stringMatching(/^Decline .*command.*pnpm install/i),
    ]);
  });
});

describe("phase6 dock guard: nothing pending means no dock", () => {
  it("phase6 dock guard derives no items for a thread with nothing waiting on the developer", () => {
    expect(derivePinnedActionDockItems(input())).toEqual([]);
  });
});

it("leaves Factory plan presentations outside the dock", () => {
  const sources = { ...input(), factoryPlans: [{ kind: "plan" }], messages: [] };
  expect(derivePinnedActionDockItems(sources)).toEqual([]);
});

it("leaves pending questions outside the dock", () => {
  const sources = { ...input(), userInputs: [{ requestId: "inline-only" }] };
  expect(derivePinnedActionDockItems(sources)).toEqual([]);
});
