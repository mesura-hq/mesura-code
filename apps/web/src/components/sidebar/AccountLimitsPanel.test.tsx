import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { AccountLimitsView } from "../../state/accountLimits";
import {
  ACCOUNT_LIMITS_POPOVER_FOCUS_PROPS,
  AccountLimitsPanelContent,
} from "./AccountLimitsPanel";

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
        environmentId,
        environmentLabel: "Laptop",
        providerInstanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        accountLabel: "Codex",
        snapshot: {
          providerInstanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          observation: {
            plan: "pro",
            observedAt: "2026-08-22T12:09:00.000Z",
            source: "event",
            windows: [
              {
                id: "seven_day",
                label: "7d",
                usedPercent: 30,
                resetsAt: "2026-08-22T17:10:00.000Z",
                windowMinutes: 10_080,
                meter: { id: "codex", label: "Codex" },
              },
              {
                id: "seven_day",
                label: "7d Spark",
                usedPercent: 5,
                resetsAt: null,
                windowMinutes: 10_080,
                meter: { id: "codex_spark", label: "GPT-5.3-Codex-Spark" },
              },
              {
                id: "nimbus_quill",
                label: "Nimbus quill",
                usedPercent: 0,
                resetsAt: null,
                windowMinutes: null,
                meter: { id: "nimbus_quill", label: "Nimbus quill" },
              },
            ],
          },
          lastAttempt: {
            attemptedAt: "2026-08-22T12:09:00.000Z",
            status: "succeeded",
            error: null,
          },
        },
        state: "current",
        environmentNowMs: Date.parse("2026-08-22T12:10:00.000Z"),
        readingAgeMs: 60_000,
      },
    ],
    isPending: false,
    isPartial: false,
    refresh: () => {},
  };
}

describe("AccountLimitsPanelContent", () => {
  it("keeps focus on the composer or terminal for hover and held-key opens", () => {
    expect(ACCOUNT_LIMITS_POPOVER_FOCUS_PROPS).toEqual({
      initialFocus: false,
      finalFocus: false,
    });
  });

  it("renders account meters, reset time, reading age, and shortcut without Spark", () => {
    const markup = renderToStaticMarkup(
      <AccountLimitsPanelContent shortcutLabel="Alt+U" view={view()} />,
    );

    expect(markup).toContain("Usage limits");
    expect(markup).toContain("Alt+U");
    expect(markup).toContain("Codex");
    expect(markup).toContain("Laptop");
    expect(markup).toContain("30%");
    expect(markup).toContain("Resets in 5h");
    expect(markup).toContain("1m ago");
    expect(markup).not.toContain("Spark");
    expect(markup).not.toContain("Nimbus");
  });

  it("renders a quiet missing-reading state", () => {
    const missing = view();
    const markup = renderToStaticMarkup(
      <AccountLimitsPanelContent
        shortcutLabel={null}
        view={{
          ...missing,
          rows: [{ ...missing.rows[0]!, snapshot: null, state: "missing", readingAgeMs: null }],
        }}
      />,
    );

    expect(markup).toContain("No reading yet");
  });
});
