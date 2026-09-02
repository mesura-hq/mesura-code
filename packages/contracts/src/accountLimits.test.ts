import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ACCOUNT_LIMITS_CONTRACT_VERSION,
  accountLimitsSubscriptionKey,
  AccountLimitsSummary,
  isFoldableSubscriptionKey,
  unfoldableInstanceSubscription,
} from "./accountLimits.ts";

const decodeSummary = Schema.decodeUnknownSync(AccountLimitsSummary);

describe("AccountLimitsSummary", () => {
  it("keeps provider-instance identity and dynamic limit windows", () => {
    const summary = decodeSummary({
      contractVersion: ACCOUNT_LIMITS_CONTRACT_VERSION,
      readAt: "2026-08-22T12:00:00.000Z",
      snapshots: [
        {
          subscription: { key: "openai:dev@example.com", label: "dev@example.com" },
          reader: { providerInstanceId: "codex_personal", driver: "codex" },
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

    expect(summary.snapshots[0]?.reader?.providerInstanceId).toBe("codex_personal");
    expect(summary.snapshots[0]?.observation?.windows[0]?.meter?.id).toBe("codex");
  });

  it("decodes a reading whose provider named no account, and marks it unfoldable", () => {
    // Clients fold two environments onto one row by subscription key. A reading
    // with no account behind it must not be folded at all, so it carries an
    // unfoldable key rather than a shared one.
    const summary = decodeSummary({
      contractVersion: ACCOUNT_LIMITS_CONTRACT_VERSION,
      readAt: "2026-08-22T12:00:00.000Z",
      snapshots: [
        {
          subscription: unfoldableInstanceSubscription({ instanceId: "claudeAgent" }),
          reader: { providerInstanceId: "claudeAgent", driver: "claudeAgent" },
          observation: {
            plan: "max",
            observedAt: "2026-08-22T11:59:00.000Z",
            source: "poll",
            windows: [
              {
                id: "five_hour",
                label: "5h",
                usedPercent: 18,
                resetsAt: "2026-08-22T16:00:00.000Z",
                windowMinutes: 300,
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

    expect(isFoldableSubscriptionKey(summary.snapshots[0]!.subscription.key)).toBe(false);
    expect(summary.snapshots[0]?.observation?.windows[0]?.observedAt).toBeUndefined();
  });

  it("keeps the account and the per-window reading date", () => {
    const summary = decodeSummary({
      contractVersion: ACCOUNT_LIMITS_CONTRACT_VERSION,
      readAt: "2026-08-22T12:00:00.000Z",
      snapshots: [
        {
          subscription: { key: "anthropic:dev@example.com", label: "dev@example.com" },
          reader: { providerInstanceId: "claudeAgent", driver: "claudeAgent" },
          observation: {
            plan: "max",
            observedAt: "2026-08-22T11:59:00.000Z",
            source: "event",
            windows: [
              {
                id: "five_hour",
                label: "5h",
                usedPercent: 18,
                resetsAt: "2026-08-22T16:00:00.000Z",
                windowMinutes: 300,
                observedAt: "2026-08-22T11:59:00.000Z",
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
          },
          lastAttempt: {
            attemptedAt: "2026-08-22T11:59:00.000Z",
            status: "succeeded",
            error: null,
          },
        },
      ],
    });

    expect(summary.snapshots[0]?.subscription.key).toBe("anthropic:dev@example.com");
    expect(summary.snapshots[0]?.observation?.windows.map((window) => window.observedAt)).toEqual([
      "2026-08-22T11:59:00.000Z",
      "2026-08-22T11:20:00.000Z",
    ]);
  });

  it("decodes future fields and unknown provider window identifiers", () => {
    const summary = decodeSummary({
      contractVersion: ACCOUNT_LIMITS_CONTRACT_VERSION,
      readAt: "2026-08-22T12:00:00.000Z",
      futureSummaryField: true,
      snapshots: [
        {
          subscription: { key: "anthropic:work@example.com", label: "work@example.com" },
          reader: { providerInstanceId: "claude_work", driver: "claudeAgent" },
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
              subscription: { key: "openai:dev@example.com", label: "dev@example.com" },
              reader: { providerInstanceId: "codex_personal", driver: "codex" },
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

describe("a subscription is the identity", () => {
  const subscription = { key: "opencode-go:9f2ab1", label: "OpenCode Go" };
  const lastAttempt = {
    attemptedAt: "2026-09-02T03:29:00.000Z",
    status: "succeeded" as const,
    error: null,
  };

  it("is version 2, because the snapshot shape changed", () => {
    expect(ACCOUNT_LIMITS_CONTRACT_VERSION).toBe(2);
  });

  it("builds a subscription key from a vendor namespace and an identifier", () => {
    expect(accountLimitsSubscriptionKey({ namespace: "zai", identifier: "9f2ab1" })).toBe(
      "zai:9f2ab1",
    );
  });

  it("folds one address read under one namespace to one key, whatever its casing", () => {
    // Two environments reporting the same subscription must produce the same
    // key or the client lists the account twice.
    expect(
      accountLimitsSubscriptionKey({ namespace: "openai", identifier: "Someone@Example.com" }),
    ).toBe(
      accountLimitsSubscriptionKey({ namespace: "openai", identifier: "someone@example.com" }),
    );
  });

  it("keeps two vendors' subscriptions apart when they share an address", () => {
    expect(
      accountLimitsSubscriptionKey({ namespace: "anthropic", identifier: "a@b.com" }),
    ).not.toBe(accountLimitsSubscriptionKey({ namespace: "openai", identifier: "a@b.com" }));
  });

  it("carries the subscription as its identity and the reader as a separate field", () => {
    const summary = decodeSummary({
      contractVersion: ACCOUNT_LIMITS_CONTRACT_VERSION,
      readAt: "2026-09-02T03:30:00.000Z",
      snapshots: [
        {
          subscription,
          reader: { providerInstanceId: "opencode_personal", driver: "opencode" },
          observation: null,
          lastAttempt,
        },
      ],
    });

    expect(summary.snapshots[0]?.subscription.key).toBe("opencode-go:9f2ab1");
    expect(summary.snapshots[0]?.reader?.driver).toBe("opencode");
  });

  it("decodes a subscription nothing read through a provider instance", () => {
    // A directly polled subscription has no provider instance at all, and
    // dropping it here is what would hide the new rows entirely.
    const summary = decodeSummary({
      contractVersion: ACCOUNT_LIMITS_CONTRACT_VERSION,
      readAt: "2026-09-02T03:30:00.000Z",
      snapshots: [{ subscription, observation: null, lastAttempt }],
    });

    expect(summary.snapshots[0]?.reader).toBeUndefined();
  });

  it("carries a failure reason from the closed set", () => {
    const summary = decodeSummary({
      contractVersion: ACCOUNT_LIMITS_CONTRACT_VERSION,
      readAt: "2026-09-02T03:30:00.000Z",
      snapshots: [
        {
          subscription,
          observation: null,
          lastAttempt: {
            attemptedAt: "2026-09-02T03:29:00.000Z",
            status: "failed",
            error: "Account-limit refresh failed.",
            reason: "unrecognized",
          },
        },
      ],
    });

    expect(summary.snapshots[0]?.lastAttempt.reason).toBe("unrecognized");
  });

  it("rejects a failure reason outside the closed set", () => {
    expect(() =>
      decodeSummary({
        contractVersion: ACCOUNT_LIMITS_CONTRACT_VERSION,
        readAt: "2026-09-02T03:30:00.000Z",
        snapshots: [
          {
            subscription,
            observation: null,
            lastAttempt: {
              attemptedAt: "2026-09-02T03:29:00.000Z",
              status: "failed",
              error: "boom",
              reason: "vendor_was_rude",
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("does not tie the failure reason to the status, which is why callers must gate on status", () => {
    // A guard on a deliberate non-guarantee: the doc comment says read `reason`
    // only where `status` is `failed`, and this pins that the schema really
    // does leave that to the caller rather than enforcing it.
    const summary = decodeSummary({
      contractVersion: ACCOUNT_LIMITS_CONTRACT_VERSION,
      readAt: "2026-09-02T03:30:00.000Z",
      snapshots: [
        {
          subscription,
          observation: null,
          lastAttempt: {
            attemptedAt: "2026-09-02T03:29:00.000Z",
            status: "succeeded",
            error: null,
            reason: "unreachable",
          },
        },
      ],
    });

    expect(summary.snapshots[0]?.lastAttempt.status).toBe("succeeded");
  });

  it("refuses a version 1 snapshot rather than decoding it with its identity absent", () => {
    // The cached file and the wire both carry these. A v1 snapshot decoding
    // into a v2 shape would produce a snapshot with no subscription at all.
    expect(() =>
      decodeSummary({
        contractVersion: ACCOUNT_LIMITS_CONTRACT_VERSION,
        readAt: "2026-09-02T03:30:00.000Z",
        snapshots: [
          {
            providerInstanceId: "codex_personal",
            driver: "codex",
            observation: null,
            lastAttempt,
          },
        ],
      }),
    ).toThrow();
  });
});
