import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ACCOUNT_LIMITS_CONTRACT_VERSION, AccountLimitsSummary } from "./accountLimits.ts";

const decodeSummary = Schema.decodeUnknownSync(AccountLimitsSummary);

describe("AccountLimitsSummary", () => {
  it("keeps provider-instance identity and dynamic limit windows", () => {
    const summary = decodeSummary({
      contractVersion: ACCOUNT_LIMITS_CONTRACT_VERSION,
      readAt: "2026-08-22T12:00:00.000Z",
      snapshots: [
        {
          providerInstanceId: "codex_personal",
          driver: "codex",
          observation: {
            plan: "pro",
            observedAt: "2026-08-22T11:59:00.000Z",
            source: "poll",
            windows: [
              {
                id: "seven_day",
                label: "7d",
                usedPercent: 31,
                resetsAt: "2026-08-28T12:00:00.000Z",
                windowMinutes: 10_080,
                meter: { id: "codex", label: "Codex" },
              },
            ],
          },
          lastAttempt: {
            attemptedAt: "2026-08-22T11:59:00.000Z",
            status: "succeeded",
            error: null,
          },
        },
      ],
    });

    expect(summary.snapshots[0]?.providerInstanceId).toBe("codex_personal");
    expect(summary.snapshots[0]?.observation?.windows[0]?.meter?.id).toBe("codex");
  });

  it("decodes future fields and unknown provider window identifiers", () => {
    const summary = decodeSummary({
      contractVersion: ACCOUNT_LIMITS_CONTRACT_VERSION,
      readAt: "2026-08-22T12:00:00.000Z",
      futureSummaryField: true,
      snapshots: [
        {
          providerInstanceId: "claude_work",
          driver: "claudeAgent",
          futureSnapshotField: "kept compatible",
          observation: {
            plan: "max",
            observedAt: "2026-08-22T11:59:00.000Z",
            source: "event",
            futureObservationField: 1,
            windows: [
              {
                id: "future_rolling_window",
                label: "Future",
                usedPercent: 8,
                resetsAt: null,
                windowMinutes: null,
                futureWindowField: [],
              },
            ],
          },
          lastAttempt: {
            attemptedAt: "2026-08-22T11:59:00.000Z",
            status: "succeeded",
            error: null,
          },
        },
      ],
    });

    expect(summary.snapshots[0]?.observation?.windows[0]?.id).toBe("future_rolling_window");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 101])(
    "rejects an invalid used percentage: %s",
    (usedPercent) => {
      expect(() =>
        decodeSummary({
          contractVersion: ACCOUNT_LIMITS_CONTRACT_VERSION,
          readAt: "2026-08-22T12:00:00.000Z",
          snapshots: [
            {
              providerInstanceId: "codex_personal",
              driver: "codex",
              observation: {
                plan: "pro",
                observedAt: "2026-08-22T11:59:00.000Z",
                source: "poll",
                windows: [
                  {
                    id: "seven_day",
                    label: "7d",
                    usedPercent,
                    resetsAt: null,
                    windowMinutes: 10_080,
                  },
                ],
              },
              lastAttempt: {
                attemptedAt: "2026-08-22T11:59:00.000Z",
                status: "succeeded",
                error: null,
              },
            },
          ],
        }),
      ).toThrow();
    },
  );
});
