import { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { AccountLimitsView } from "../../state/accountLimits";
import { AccountLimitsPanelContent, rowEntranceDelayMs } from "./AccountLimitsPanel";

const environmentId = EnvironmentId.make("local");

function view(): AccountLimitsView {
  return {
    environments: [
      {
        environmentId,
        label: "Laptop",
        connectionPhase: "connected",
        providers: [],
        isPending: false,
        error: null,
        summary: null,
        receivedAtMs: null,
        state: "ready",
      },
      {
        environmentId: EnvironmentId.make("remote"),
        label: "Remote",
        connectionPhase: "offline",
        providers: [],
        isPending: false,
        error: null,
        summary: null,
        receivedAtMs: null,
        state: "disconnected",
      },
    ],
    rows: [
      {
        key: "codex:dev@example.com",
        driver: ProviderDriverKind.make("codex"),
        providerLabel: "Codex",
        plan: "pro",
        subtitle: "Laptop",
        environments: [{ environmentId, label: "Laptop" }],
        windows: [
          {
            window: {
              id: "seven_day",
              label: "7d",
              usedPercent: 30,
              resetsAt: "2026-08-22T17:10:00.000Z",
              windowMinutes: 10_080,
              meter: { id: "codex", label: "Codex" },
            },
            environmentNowMs: Date.parse("2026-08-22T12:10:00.000Z"),
            ageMs: 60_000,
          },
        ],
        state: "current",
        readingAgeMs: 60_000,
      },
    ],
    isPending: false,
    isPartial: false,
    refresh: () => {},
  };
}

describe("rowEntranceDelayMs", () => {
  it("starts each row a beat after the one above it", () => {
    expect(rowEntranceDelayMs(0, true)).toBe(0);
    expect(rowEntranceDelayMs(1, true)).toBeGreaterThan(rowEntranceDelayMs(0, true));
    expect(rowEntranceDelayMs(2, true)).toBeGreaterThan(rowEntranceDelayMs(1, true));
  });

  // Without the cap the last row of a long panel waits on every row above it,
  // which stops reading as a sequence and starts reading as that row lagging.
  it("stops adding delay once the sequence is established", () => {
    expect(rowEntranceDelayMs(20, true)).toBe(rowEntranceDelayMs(50, true));
  });

  // A staggered exit makes dismissal feel slower than it is, and the dock
  // collapses over the top of the rows anyway.
  it("gives closing rows no delay at all", () => {
    for (const index of [0, 1, 5, 20]) expect(rowEntranceDelayMs(index, false)).toBe(0);
  });
});

describe("AccountLimitsPanelContent", () => {
  it("renders account meters, reset time, reading age, and shortcut", () => {
    const markup = renderToStaticMarkup(
      <AccountLimitsPanelContent open shortcutLabel="Alt+U" view={view()} />,
    );

    expect(markup).toContain("Usage limits");
    expect(markup).toContain("Alt+U");
    expect(markup).toContain("Codex");
    expect(markup).toContain("Laptop");
    expect(markup).toContain("30%");
    // The rotate icon carries "resets in" visually; the words stay for readers
    // that cannot see it, so the countdown is never a bare duration.
    // The rotate icon carries "resets in" visually; the full sentence stays for
    // readers that cannot see it.
    expect(markup).toContain("Resets in 5h");
    expect(markup).toContain("1m ago");
    expect(markup).toContain("data-usage-limits-panel");
  });

  it("renders a quiet missing-reading state", () => {
    const missing = view();
    const markup = renderToStaticMarkup(
      <AccountLimitsPanelContent
        open
        shortcutLabel={null}
        view={{
          ...missing,
          rows: [{ ...missing.rows[0]!, windows: [], state: "missing", readingAgeMs: null }],
        }}
      />,
    );

    expect(markup).toContain("No reading yet");
  });
});
