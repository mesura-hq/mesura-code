/**
 * Phase 5 fence: the mobile-only logic behind the Android context-window
 * indicator. Entry point: the pure functions in `./contextWindowIndicatorState`,
 * which `useSelectedThreadContextWindow` and `ContextWindowIndicator` call from
 * `ThreadComposer`. The snapshot itself comes from
 * `@t3tools/client-runtime/context-window`. These specs cover only the guards
 * the mobile app adds on top of it. The accessibility label is specced with
 * the shared module.
 */
import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, ThreadId, TurnId } from "@t3tools/contracts";
import { deriveLatestContextWindowSnapshot } from "@t3tools/client-runtime/context-window";

import {
  isContextWindowCompactDisabled,
  layoutContextWindowBarParts,
  selectThreadContextWindowSnapshot,
  shouldShowContextWindowIndicator,
} from "./contextWindowIndicatorState";

const composerThreadId = ThreadId.make("thread-composer");
const otherThreadId = ThreadId.make("thread-other");

function makeContextWindowActivity(payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make("activity-context-window"),
    tone: "info",
    kind: "context-window.updated",
    summary: "Context updated",
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-10-04T00:00:00.000Z",
  };
}

function makeToolActivity(): OrchestrationThreadActivity {
  return {
    id: EventId.make("activity-tool"),
    tone: "tool",
    kind: "tool.completed",
    summary: "Ran a command",
    payload: {},
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-10-04T00:00:01.000Z",
  };
}

const usedOfOneMillion = makeContextWindowActivity({ usedTokens: 65_000, maxTokens: 1_000_000 });

function snapshotFor(payload: unknown) {
  const snapshot = deriveLatestContextWindowSnapshot([makeContextWindowActivity(payload)]);
  if (!snapshot) throw new Error("fixture payload produced no snapshot");
  return snapshot;
}

describe("mobile selectThreadContextWindowSnapshot", () => {
  it("returns the latest snapshot of the composer's own thread", () => {
    const snapshot = selectThreadContextWindowSnapshot({
      detail: { id: composerThreadId, activities: [usedOfOneMillion, makeToolActivity()] },
      threadId: composerThreadId,
    });
    expect(snapshot?.usedTokens).toBe(65_000);
    expect(snapshot?.maxTokens).toBe(1_000_000);
  });

  it("returns null when the thread detail is absent", () => {
    expect(selectThreadContextWindowSnapshot({ detail: null, threadId: composerThreadId })).toBe(
      null,
    );
  });

  it("returns null when the detail belongs to another thread", () => {
    expect(
      selectThreadContextWindowSnapshot({
        detail: { id: otherThreadId, activities: [usedOfOneMillion] },
        threadId: composerThreadId,
      }),
    ).toBe(null);
  });

  it("returns null when the thread has no context-window activity", () => {
    expect(
      selectThreadContextWindowSnapshot({
        detail: { id: composerThreadId, activities: [makeToolActivity()] },
        threadId: composerThreadId,
      }),
    ).toBe(null);
  });
});

describe("mobile shouldShowContextWindowIndicator", () => {
  const visibleInput = {
    snapshot: snapshotFor({ usedTokens: 65_000, maxTokens: 1_000_000 }),
    threadId: composerThreadId,
    providerReportsContextWindow: true,
    isVoiceInputPresented: false,
  } as const;

  it("shows the indicator for a thread with a snapshot from a reporting provider", () => {
    expect(shouldShowContextWindowIndicator(visibleInput)).toBe(true);
  });

  it("shows the indicator while the provider is not in the catalog yet", () => {
    expect(
      shouldShowContextWindowIndicator({ ...visibleInput, providerReportsContextWindow: null }),
    ).toBe(true);
  });

  it("hides the indicator when there is no snapshot", () => {
    expect(shouldShowContextWindowIndicator({ ...visibleInput, snapshot: null })).toBe(false);
  });

  it("hides the indicator for a draft with no thread", () => {
    expect(shouldShowContextWindowIndicator({ ...visibleInput, threadId: null })).toBe(false);
  });

  it("hides the indicator when the provider reports no context window", () => {
    expect(
      shouldShowContextWindowIndicator({ ...visibleInput, providerReportsContextWindow: false }),
    ).toBe(false);
  });

  it("hides the indicator while voice input is presented", () => {
    expect(shouldShowContextWindowIndicator({ ...visibleInput, isVoiceInputPresented: true })).toBe(
      false,
    );
  });
});

describe("mobile isContextWindowCompactDisabled", () => {
  it("enables compact for an idle started session with a compactable conversation", () => {
    expect(
      isContextWindowCompactDisabled({ hasCompactableConversation: true, sessionStatus: "ready" }),
    ).toBe(false);
  });

  it("disables compact during a running or starting turn, whatever the draft holds", () => {
    expect(
      isContextWindowCompactDisabled({
        hasCompactableConversation: true,
        sessionStatus: "running",
      }),
    ).toBe(true);
    expect(
      isContextWindowCompactDisabled({
        hasCompactableConversation: true,
        sessionStatus: "starting",
      }),
    ).toBe(true);
  });

  it("enables compact once the session has settled after a turn", () => {
    for (const sessionStatus of ["idle", "ready", "interrupted", "stopped", "error"] as const) {
      expect(
        isContextWindowCompactDisabled({ hasCompactableConversation: true, sessionStatus }),
      ).toBe(false);
    }
  });

  it("disables compact when the conversation is not compactable", () => {
    expect(
      isContextWindowCompactDisabled({ hasCompactableConversation: false, sessionStatus: "ready" }),
    ).toBe(true);
  });

  it("disables compact before the thread has a session", () => {
    expect(
      isContextWindowCompactDisabled({ hasCompactableConversation: true, sessionStatus: null }),
    ).toBe(true);
  });
});

describe("mobile layoutContextWindowBarParts", () => {
  it("weights request parts by fraction with no remainder, so gaps cannot push output out", () => {
    // The reviewer's case: input 189,900 = cache read 60,000 + write 120,000 + new 9,900, output 100.
    const parts = layoutContextWindowBarParts(
      [
        { kind: "cacheRead", tokens: 60_000, fraction: 60_000 / 190_000 },
        { kind: "cacheWrite", tokens: 120_000, fraction: 120_000 / 190_000 },
        { kind: "uncached", tokens: 9_900, fraction: 9_900 / 190_000 },
        { kind: "output", tokens: 100, fraction: 100 / 190_000 },
      ],
      "request",
    );
    expect(parts.map((part) => part.kind)).toEqual([
      "cacheRead",
      "cacheWrite",
      "uncached",
      "output",
    ]);
    expect(parts.every((part) => part.grow > 0)).toBe(true);
  });

  it("gives each bar part its fraction as its flex weight and drops empty parts", () => {
    expect(
      layoutContextWindowBarParts(
        [
          { kind: "cacheRead", tokens: 600, fraction: 0.6 },
          { kind: "cacheWrite", tokens: 0, fraction: 0 },
          { kind: "output", tokens: 400, fraction: 0.4 },
        ],
        "request",
      ),
    ).toEqual([
      { key: "cacheRead", kind: "cacheRead", grow: 0.6 },
      { key: "output", kind: "output", grow: 0.4 },
    ]);
  });

  it("adds an unfilled remainder on the window scale", () => {
    const parts = layoutContextWindowBarParts(
      [
        { kind: "cacheRead", tokens: 40_000, fraction: 0.04 },
        { kind: "output", tokens: 25_000, fraction: 0.025 },
      ],
      "window",
    );
    expect(parts.at(-1)).toEqual({ key: "remainder", kind: null, grow: 1 - 0.065 });
  });

  it("adds no remainder when the window is full", () => {
    const parts = layoutContextWindowBarParts(
      [{ kind: "input", tokens: 1_000_000, fraction: 1 }],
      "window",
    );
    expect(parts.map((part) => part.kind)).toEqual(["input"]);
  });

  it("returns no parts when nothing is filled", () => {
    expect(layoutContextWindowBarParts([], "request")).toEqual([]);
  });
});
