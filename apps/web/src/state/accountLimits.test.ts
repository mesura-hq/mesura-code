import {
  ACCOUNT_LIMITS_CONTRACT_VERSION,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type AccountLimitsSnapshot,
  type AccountLimitsSummary,
  type AccountLimitsWindow,
  type ServerProvider,
  type ServerProviderState,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  projectAccountLimits,
  selectVisibleAccountLimitWindows,
  type AccountLimitsRow,
  type EnvironmentAccountLimitsInput,
} from "./accountLimits";

const NOW = Date.parse("2026-08-22T12:10:00.000Z");

function provider(input: {
  readonly instanceId: string;
  readonly driver: "claudeAgent" | "codex";
  readonly displayName?: string;
  readonly accentColor?: string;
  readonly installed?: boolean;
  readonly status?: ServerProviderState;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    enabled: true,
    installed: input.installed ?? true,
    version: null,
    status: input.status ?? "ready",
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
  readonly accountKey?: string;
  readonly accountLabel?: string;
  readonly windows?: readonly AccountLimitsWindow[];
}): AccountLimitsSnapshot {
  const observedAt = input.observedAt ?? "2026-08-22T12:09:00.000Z";
  return {
    providerInstanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    ...(input.accountKey
      ? { account: { key: input.accountKey, label: input.accountLabel ?? input.accountKey } }
      : {}),
    observation: {
      plan: "pro",
      observedAt,
      source: "poll",
      windows: input.windows ?? [
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

function percentOf(row: AccountLimitsRow | undefined, windowId = "seven_day"): number | undefined {
  return row?.windows.find((entry) => entry.window.id === windowId)?.window.usedPercent;
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
            snapshot({
              instanceId: "codex",
              driver: "codex",
              usedPercent: 20,
              accountKey: "codex:home@example.com",
              accountLabel: "home@example.com",
            }),
            snapshot({
              instanceId: "codex_work",
              driver: "codex",
              usedPercent: 70,
              accountKey: "codex:work@example.com",
              accountLabel: "work@example.com",
            }),
          ]),
        }),
      ],
      NOW,
    );

    expect(result.rows.map((row) => row.providerLabel)).toEqual(["Codex", "Work account"]);
    expect(result.rows[1]?.accentColor).toBe("#4ade80");
    // Two names the user already set apart tell themselves apart; an address
    // under each would be noise.
    expect(result.rows.map((row) => row.subtitle)).toEqual([null, null]);
  });

  it("folds one subscription read from two environments into one row", () => {
    const providers = [provider({ instanceId: "claudeAgent", driver: "claudeAgent" })];
    const result = projectAccountLimits(
      [
        environment({
          id: "arch",
          label: "arch",
          providers,
          summary: summary(
            [
              snapshot({
                instanceId: "claudeAgent",
                driver: "claudeAgent",
                usedPercent: 0,
                accountKey: "claudeAgent:dev@example.com",
                accountLabel: "dev@example.com",
                observedAt: "2026-08-22T12:04:00.000Z",
                windows: [
                  {
                    id: "five_hour",
                    label: "5h",
                    usedPercent: 13,
                    resetsAt: "2026-08-22T16:00:00.000Z",
                    windowMinutes: 300,
                    // Carried over by a merge: older than the reading around it.
                    observedAt: "2026-08-22T11:40:00.000Z",
                  },
                  {
                    id: "seven_day",
                    label: "7d",
                    usedPercent: 17,
                    resetsAt: "2026-08-29T12:00:00.000Z",
                    windowMinutes: 10_080,
                    observedAt: "2026-08-22T12:04:00.000Z",
                  },
                ],
              }),
            ],
            "2026-08-22T12:10:00.000Z",
          ),
        }),
        environment({
          id: "vigilia",
          label: "vigilia-home",
          providers,
          summary: summary(
            [
              snapshot({
                instanceId: "claudeAgent",
                driver: "claudeAgent",
                usedPercent: 0,
                accountKey: "claudeAgent:dev@example.com",
                accountLabel: "dev@example.com",
                observedAt: "2026-08-22T12:06:00.000Z",
                windows: [
                  {
                    id: "five_hour",
                    label: "5h",
                    usedPercent: 18,
                    resetsAt: "2026-08-22T16:00:00.000Z",
                    windowMinutes: 300,
                    observedAt: "2026-08-22T12:06:00.000Z",
                  },
                  {
                    id: "seven_day",
                    label: "7d",
                    usedPercent: 17,
                    resetsAt: "2026-08-29T12:00:00.000Z",
                    windowMinutes: 10_080,
                    observedAt: "2026-08-22T11:20:00.000Z",
                  },
                ],
              }),
            ],
            "2026-08-22T12:10:00.000Z",
          ),
        }),
      ],
      NOW,
    );

    expect(result.rows).toHaveLength(1);
    // Each window takes the freshest of the two environments, not one whole
    // environment's reading.
    expect(percentOf(result.rows[0], "five_hour")).toBe(18);
    expect(percentOf(result.rows[0], "seven_day")).toBe(17);
    expect(result.rows[0]?.windows.find((entry) => entry.window.id === "seven_day")?.ageMs).toBe(
      6 * 60_000,
    );
    expect(result.rows[0]?.readingAgeMs).toBe(4 * 60_000);
    // One subscription needs nothing to tell it apart.
    expect(result.rows[0]?.subtitle).toBeNull();
    expect(result.rows[0]?.environments.map((entry) => entry.label)).toEqual([
      "arch",
      "vigilia-home",
    ]);
  });

  it("dates a window from the observation when the environment reports no window date", () => {
    const providers = [provider({ instanceId: "codex", driver: "codex" })];
    const result = projectAccountLimits(
      [
        environment({
          id: "old",
          label: "Old server",
          providers,
          summary: summary(
            [
              snapshot({
                instanceId: "codex",
                driver: "codex",
                usedPercent: 40,
                accountKey: "codex:dev@example.com",
                observedAt: "2026-08-22T12:08:00.000Z",
              }),
            ],
            "2026-08-22T12:10:00.000Z",
          ),
        }),
      ],
      NOW,
    );

    expect(result.rows[0]?.readingAgeMs).toBe(2 * 60_000);
  });

  it("keeps equal instance ids apart when no environment names an account", () => {
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
    expect(result.rows.map((row) => row.subtitle)).toEqual(["Laptop", "Server"]);
    expect(result.rows.map((row) => row.state)).toEqual(["current", "current"]);
    expect(result.rows.map((row) => percentOf(row))).toEqual([15, 65]);
  });

  it("leaves out an errored provider that never produced a reading", () => {
    // The case this exists for: a machine without the Codex CLI installed
    // answers every read with a failure, and a permanent "Refresh failed" row
    // reads as a broken subscription rather than as an absent provider.
    const result = projectAccountLimits(
      [
        environment({
          id: "server",
          label: "Server",
          providers: [
            provider({ instanceId: "claudeAgent", driver: "claudeAgent" }),
            provider({
              instanceId: "codex",
              driver: "codex",
              installed: false,
              status: "error",
            }),
          ],
          summary: summary([
            snapshot({ instanceId: "claudeAgent", driver: "claudeAgent", usedPercent: 10 }),
            {
              providerInstanceId: ProviderInstanceId.make("codex"),
              driver: ProviderDriverKind.make("codex"),
              observation: null,
              lastAttempt: {
                attemptedAt: "2026-08-22T12:09:00.000Z",
                status: "failed",
                error: "Account-limit refresh failed.",
              },
            },
          ]),
        }),
      ],
      NOW,
    );

    expect(result.rows.map((row) => row.driver)).toEqual(["claudeAgent"]);
  });

  it("keeps a degraded provider that already reported a reading", () => {
    // `ready` is a narrow bar. An instance can sit at `warning` and still be the
    // one metering the account, so a reading already in hand keeps its row.
    const result = projectAccountLimits(
      [
        environment({
          id: "server",
          label: "Server",
          providers: [provider({ instanceId: "codex", driver: "codex", status: "warning" })],
          summary: summary([snapshot({ instanceId: "codex", driver: "codex", usedPercent: 44 })]),
        }),
      ],
      NOW,
    );

    expect(percentOf(result.rows[0])).toBe(44);
  });

  it("does not read `installed` as the gate", () => {
    // The probe reports both, and only `status` says whether a read can answer.
    const result = projectAccountLimits(
      [
        environment({
          id: "server",
          label: "Server",
          providers: [provider({ instanceId: "codex", driver: "codex", installed: false })],
          summary: summary([snapshot({ instanceId: "codex", driver: "codex", usedPercent: 12 })]),
        }),
      ],
      NOW,
    );

    expect(percentOf(result.rows[0])).toBe(12);
  });

  it("keeps one address on two providers apart", () => {
    const result = projectAccountLimits(
      [
        environment({
          id: "local",
          label: "Laptop",
          providers: [
            provider({ instanceId: "claudeAgent", driver: "claudeAgent" }),
            provider({ instanceId: "codex", driver: "codex" }),
          ],
          summary: summary([
            snapshot({
              instanceId: "claudeAgent",
              driver: "claudeAgent",
              usedPercent: 30,
              accountKey: "claudeAgent:dev@example.com",
            }),
            snapshot({
              instanceId: "codex",
              driver: "codex",
              usedPercent: 70,
              accountKey: "codex:dev@example.com",
            }),
          ]),
        }),
      ],
      NOW,
    );

    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((row) => percentOf(row))).toEqual([30, 70]);
  });

  it("does not fold an environment that reports no account into one that does", () => {
    // The mixed-build case the optional contract fields exist for: an
    // environment on an older build sends no account key and must keep its own
    // row rather than inheriting another machine's numbers.
    const providers = [provider({ instanceId: "codex", driver: "codex" })];
    const result = projectAccountLimits(
      [
        environment({
          id: "new",
          label: "Updated",
          providers,
          summary: summary([
            snapshot({
              instanceId: "codex",
              driver: "codex",
              usedPercent: 30,
              accountKey: "codex:dev@example.com",
              accountLabel: "dev@example.com",
            }),
          ]),
        }),
        environment({
          id: "old",
          label: "Older build",
          providers,
          summary: summary([snapshot({ instanceId: "codex", driver: "codex", usedPercent: 55 })]),
        }),
      ],
      NOW,
    );

    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((row) => percentOf(row))).toEqual([30, 55]);
    expect(result.rows[1]?.key.startsWith("#env:")).toBe(true);
    expect(result.rows.map((row) => row.subtitle)).toEqual(["dev@example.com", "Older build"]);
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

    expect(percentOf(result.rows[0])).toBe(25);
  });

  it("hides meters that are presentation-only", () => {
    const result = projectAccountLimits(
      [
        environment({
          id: "local",
          label: "Laptop",
          providers: [provider({ instanceId: "codex", driver: "codex" })],
          summary: summary([
            snapshot({
              instanceId: "codex",
              driver: "codex",
              usedPercent: 0,
              windows: [
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
                  meter: { id: "codex_spark", label: "GPT-5.3-Codex-Spark" },
                },
              ],
            }),
          ]),
        }),
      ],
      NOW,
    );

    expect(result.rows[0]?.windows.map((entry) => entry.window.label)).toEqual(["7d"]);
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

  it("reports a folded subscription as healthy when one environment refreshed it", () => {
    const providers = [provider({ instanceId: "claudeAgent", driver: "claudeAgent" })];
    const result = projectAccountLimits(
      [
        environment({
          id: "arch",
          label: "arch",
          providers,
          summary: summary([
            snapshot({
              instanceId: "claudeAgent",
              driver: "claudeAgent",
              usedPercent: 12,
              accountKey: "claudeAgent:dev@example.com",
              observedAt: "2026-08-22T11:00:00.000Z",
              attemptedAt: "2026-08-22T12:09:00.000Z",
              failed: true,
            }),
          ]),
        }),
        environment({
          id: "vigilia",
          label: "vigilia-home",
          providers,
          summary: summary([
            snapshot({
              instanceId: "claudeAgent",
              driver: "claudeAgent",
              usedPercent: 21,
              accountKey: "claudeAgent:dev@example.com",
              observedAt: "2026-08-22T12:09:00.000Z",
            }),
          ]),
        }),
      ],
      NOW,
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.state).toBe("current");
    expect(percentOf(result.rows[0])).toBe(21);
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
