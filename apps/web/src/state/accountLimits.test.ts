import {
  ACCOUNT_LIMITS_CONTRACT_VERSION,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type AccountLimitsSnapshot,
  type AccountLimitsSummary,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  projectAccountLimits,
  selectVisibleAccountLimitWindows,
  type EnvironmentAccountLimitsInput,
} from "./accountLimits";

const NOW = Date.parse("2026-08-22T12:10:00.000Z");

function provider(input: {
  readonly instanceId: string;
  readonly driver: "claudeAgent" | "codex";
  readonly displayName?: string;
  readonly accentColor?: string;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-22T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

function snapshot(input: {
  readonly instanceId: string;
  readonly driver: "claudeAgent" | "codex";
  readonly usedPercent: number;
  readonly observedAt?: string;
  readonly attemptedAt?: string;
  readonly failed?: boolean;
}): AccountLimitsSnapshot {
  const observedAt = input.observedAt ?? "2026-08-22T12:09:00.000Z";
  return {
    providerInstanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    observation: {
      plan: "pro",
      observedAt,
      source: "poll",
      windows: [
        {
          id: "seven_day",
          label: "7d",
          usedPercent: input.usedPercent,
          resetsAt: "2026-08-29T12:00:00.000Z",
          windowMinutes: 10_080,
        },
      ],
    },
    lastAttempt: {
      attemptedAt: input.attemptedAt ?? observedAt,
      status: input.failed ? "failed" : "succeeded",
      error: input.failed ? "Account-limit refresh failed." : null,
    },
  };
}

function summary(
  snapshots: readonly AccountLimitsSnapshot[],
  readAt = "2026-08-22T12:10:00.000Z",
): AccountLimitsSummary {
  return {
    contractVersion: ACCOUNT_LIMITS_CONTRACT_VERSION,
    readAt,
    snapshots,
  };
}

function environment(input: {
  readonly id: string;
  readonly label: string;
  readonly providers: readonly ServerProvider[];
  readonly summary: AccountLimitsSummary | null;
  readonly phase?: EnvironmentAccountLimitsInput["connectionPhase"];
  readonly isPending?: boolean;
  readonly error?: string | null;
}): EnvironmentAccountLimitsInput {
  return {
    environmentId: EnvironmentId.make(input.id),
    label: input.label,
    connectionPhase: input.phase ?? "connected",
    providers: input.providers,
    summary: input.summary,
    isPending: input.isPending ?? false,
    error: input.error ?? null,
    receivedAtMs: NOW,
  };
}

describe("projectAccountLimits", () => {
  it("keeps several accounts in one environment and uses provider-instance presentation", () => {
    const result = projectAccountLimits(
      [
        environment({
          id: "local",
          label: "Laptop",
          providers: [
            provider({ instanceId: "codex", driver: "codex" }),
            provider({
              instanceId: "codex_work",
              driver: "codex",
              displayName: "Work account",
              accentColor: "#4ade80",
            }),
          ],
          summary: summary([
            snapshot({ instanceId: "codex", driver: "codex", usedPercent: 20 }),
            snapshot({ instanceId: "codex_work", driver: "codex", usedPercent: 70 }),
          ]),
        }),
      ],
      NOW,
    );

    expect(result.rows.map((row) => row.accountLabel)).toEqual(["Codex", "Work account"]);
    expect(result.rows[1]?.accentColor).toBe("#4ade80");
  });

  it("keeps equal instance ids in different environments despite clock skew", () => {
    const providers = [provider({ instanceId: "codex", driver: "codex" })];
    const result = projectAccountLimits(
      [
        environment({
          id: "laptop",
          label: "Laptop",
          providers,
          summary: summary(
            [
              snapshot({
                instanceId: "codex",
                driver: "codex",
                usedPercent: 15,
                observedAt: "2026-08-22T12:30:00.000Z",
              }),
            ],
            "2026-08-22T12:31:00.000Z",
          ),
        }),
        environment({
          id: "server",
          label: "Server",
          providers,
          summary: summary(
            [
              snapshot({
                instanceId: "codex",
                driver: "codex",
                usedPercent: 65,
                observedAt: "2026-08-22T11:30:00.000Z",
              }),
            ],
            "2026-08-22T11:31:00.000Z",
          ),
        }),
      ],
      NOW,
    );

    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((row) => row.environmentLabel)).toEqual(["Laptop", "Server"]);
    expect(result.rows.map((row) => row.state)).toEqual(["current", "current"]);
    expect(result.rows.map((row) => row.snapshot?.observation?.windows[0]?.usedPercent)).toEqual([
      15, 65,
    ]);
  });

  it("chooses the newest duplicate only inside one environment and instance", () => {
    const result = projectAccountLimits(
      [
        environment({
          id: "local",
          label: "Laptop",
          providers: [provider({ instanceId: "claude", driver: "claudeAgent" })],
          summary: summary([
            snapshot({
              instanceId: "claude",
              driver: "claudeAgent",
              usedPercent: 80,
              attemptedAt: "2026-08-22T12:08:00.000Z",
            }),
            snapshot({
              instanceId: "claude",
              driver: "claudeAgent",
              usedPercent: 25,
              attemptedAt: "2026-08-22T12:09:00.000Z",
            }),
          ]),
        }),
      ],
      NOW,
    );

    expect(result.rows[0]?.snapshot?.observation?.windows[0]?.usedPercent).toBe(25);
  });

  it("reports unsupported contracts, disconnected environments, and missing snapshots", () => {
    const oldSummary = { ...summary([]), contractVersion: 0 };
    const result = projectAccountLimits(
      [
        environment({
          id: "old",
          label: "Old server",
          providers: [],
          summary: oldSummary,
        }),
        environment({
          id: "offline",
          label: "Offline server",
          providers: [],
          summary: null,
          phase: "offline",
        }),
        environment({
          id: "empty",
          label: "Empty",
          providers: [provider({ instanceId: "codex", driver: "codex" })],
          summary: summary([]),
        }),
      ],
      NOW,
    );

    expect(result.environments.map((entry) => entry.state)).toEqual([
      "unsupported-contract",
      "disconnected",
      "ready",
    ]);
    expect(result.rows[0]?.state).toBe("missing");
  });

  it("reports initial loading and partial environment coverage", () => {
    const pending = environment({
      id: "pending",
      label: "Pending",
      providers: [],
      summary: null,
      isPending: true,
    });
    expect(projectAccountLimits([pending], NOW).isPending).toBe(true);

    const partial = projectAccountLimits(
      [
        pending,
        environment({
          id: "ready",
          label: "Ready",
          providers: [],
          summary: summary([]),
        }),
      ],
      NOW,
    );
    expect(partial.isPending).toBe(false);
    expect(partial.isPartial).toBe(true);
  });

  it("distinguishes current, stale, failed, and stale-failed readings", () => {
    const result = projectAccountLimits(
      [
        environment({
          id: "local",
          label: "Laptop",
          providers: [
            provider({ instanceId: "claude_current", driver: "claudeAgent" }),
            provider({ instanceId: "claude_stale", driver: "claudeAgent" }),
            provider({ instanceId: "claude_failed", driver: "claudeAgent" }),
            provider({ instanceId: "claude_stale_failed", driver: "claudeAgent" }),
          ],
          summary: summary([
            snapshot({
              instanceId: "claude_current",
              driver: "claudeAgent",
              usedPercent: 10,
              observedAt: "2026-08-22T12:06:00.000Z",
            }),
            snapshot({
              instanceId: "claude_stale",
              driver: "claudeAgent",
              usedPercent: 20,
              observedAt: "2026-08-22T12:05:00.000Z",
            }),
            snapshot({
              instanceId: "claude_failed",
              driver: "claudeAgent",
              usedPercent: 30,
              observedAt: "2026-08-22T12:09:00.000Z",
              attemptedAt: "2026-08-22T12:10:00.000Z",
              failed: true,
            }),
            snapshot({
              instanceId: "claude_stale_failed",
              driver: "claudeAgent",
              usedPercent: 50,
              observedAt: "2026-08-22T11:00:00.000Z",
              attemptedAt: "2026-08-22T12:09:00.000Z",
              failed: true,
            }),
          ]),
        }),
      ],
      NOW,
    );

    expect(result.rows.map((row) => row.state)).toEqual([
      "current",
      "stale",
      "refresh-failed",
      "stale-refresh-failed",
    ]);
  });
});

describe("selectVisibleAccountLimitWindows", () => {
  it("hides Spark only in presentation and leaves source data unchanged", () => {
    const windows = [
      {
        id: "seven_day",
        label: "7d",
        usedPercent: 20,
        resetsAt: null,
        windowMinutes: 10_080,
        meter: { id: "codex", label: "Codex" },
      },
      {
        id: "seven_day",
        label: "7d Spark",
        usedPercent: 5,
        resetsAt: null,
        windowMinutes: 10_080,
        meter: { id: "codex_bengalfox", label: "GPT-5.3-Codex-Spark" },
      },
      {
        id: "five_hour",
        label: "5h Spark",
        usedPercent: 8,
        resetsAt: null,
        windowMinutes: 300,
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
    ] as const;

    expect(selectVisibleAccountLimitWindows(windows)).toEqual([windows[0]]);
    expect(windows).toHaveLength(4);
  });
});
