/**
 * Mesura: Antigravity's quota probe, read by the usage dock.
 *
 * The probe already feeds the composer's limits, so the dock reuses it rather than
 * opening a second route to Google's quota endpoints.
 *
 * @module usage/antigravityAccountLimits
 */
import {
  ACCOUNT_LIMITS_VENDOR_NAME,
  accountLimitsSubscriptionKey,
  boundedAccountLimitsLabel,
  ServerProviderUsageLimits,
  type AccountLimitsWindow,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import type { AccountLimitsRead } from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type NormalizedAccountLimits, windowIdAndLabel } from "./accountLimitsNormalize.ts";

const decodeUsageLimits = Schema.decodeUnknownOption(ServerProviderUsageLimits);

/**
 * One reading per signed-in Google account, keyed by the probe's account fingerprint so the
 * same account on two machines folds into one row.
 *
 * A profile with no Google sign-in reports no subscription, so it gets no row rather than a
 * "No reading yet" that only a sign-in could clear. A probe that failed is a failed read.
 */
export const readAntigravityAccountLimits = (input: {
  readonly probe: Effect.Effect<ServerProviderUsageLimits>;
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string | undefined;
}): Effect.Effect<ReadonlyArray<AccountLimitsRead>, ProviderDriverError> =>
  input.probe.pipe(
    Effect.flatMap((limits) => {
      if (limits.unavailable?.reason === "unsupported") return Effect.succeed([]);
      if (limits.unavailable !== undefined || limits.windows.length === 0) {
        return Effect.fail(
          new ProviderDriverError({
            driver: input.driver,
            instanceId: input.instanceId,
            detail: limits.unavailable?.message ?? "Failed to read Antigravity account limits.",
          }),
        );
      }
      const fingerprint = limits.credentialFingerprint;
      return Effect.succeed([
        {
          payload: limits,
          ...(fingerprint === undefined
            ? {}
            : {
                account: {
                  key: accountLimitsSubscriptionKey({
                    namespace: "antigravity",
                    identifier: fingerprint,
                  }),
                  label:
                    boundedAccountLimitsLabel(input.displayName ?? "") ??
                    ACCOUNT_LIMITS_VENDOR_NAME.antigravity,
                },
              }),
        },
      ]);
    }),
  );

/** The family before the probe's " · " separator, e.g. "Gemini" from "Gemini · 5-hour". */
function windowFamily(label: string): string | null {
  const separator = label.indexOf(" · ");
  return separator === -1 ? null : label.slice(0, separator);
}

/**
 * Probe windows as dock windows. The label keeps the probe's family and swaps its spelled-out
 * length for the dock's short form ("Gemini · 5h"), so every vendor's bars read alike.
 */
export function normalizeAntigravityAccountLimits(value: unknown): NormalizedAccountLimits | null {
  const limits = Option.getOrNull(decodeUsageLimits(value));
  if (limits === null || limits.windows.length === 0) return null;
  const windows = limits.windows.map((window): AccountLimitsWindow => {
    const minutes = window.windowDurationMins ?? null;
    const family = windowFamily(window.label);
    return {
      id: window.id,
      label:
        family === null || minutes === null
          ? window.label
          : `${family} · ${windowIdAndLabel(minutes).label}`,
      usedPercent: window.usedPercent,
      resetsAt: window.resetsAt ?? null,
      windowMinutes: minutes,
    };
  });
  return { plan: null, windows };
}
