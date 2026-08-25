/**
 * Account subscription-limit contract.
 *
 * Providers meter subscription use through rolling windows. The window list
 * stays data-driven because providers add, remove, and scope meters without a
 * client release.
 *
 * @module accountLimits
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const ACCOUNT_LIMITS_CONTRACT_VERSION = 1 as const;

const AccountLimitsErrorDetail = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
/** Provider-supplied and forwarded verbatim, so it is bounded like the rest. */
const AccountLimitsIdentifier = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const AccountLimitsPercent = Schema.Number.check(
  Schema.isFinite(),
  Schema.isBetween({ minimum: 0, maximum: 100 }),
);

export const AccountLimitsMeter = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
});
export type AccountLimitsMeter = typeof AccountLimitsMeter.Type;

export const AccountLimitsWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  usedPercent: AccountLimitsPercent,
  resetsAt: Schema.NullOr(Schema.String),
  windowMinutes: Schema.NullOr(Schema.Number),
  meter: Schema.optional(AccountLimitsMeter),
  /**
   * When this window's number was read, on the reporting environment's clock.
   *
   * Windows in one observation can carry different times: a provider event
   * refreshes the single window it names and leaves the others untouched.
   * Absent on readings taken before this field existed; callers fall back to
   * the observation's `observedAt`.
   */
  observedAt: Schema.optional(Schema.String),
});
export type AccountLimitsWindow = typeof AccountLimitsWindow.Type;

/**
 * The subscription a reading belongs to.
 *
 * `key` identifies the subscription across environments: two environments that
 * report the same key share one account, so the client folds them into one row
 * instead of listing the same limits once per machine. It is absent when the
 * provider does not name an account — an environment reporting no key is never
 * folded into another.
 */
export const AccountLimitsAccount = Schema.Struct({
  key: AccountLimitsIdentifier,
  label: AccountLimitsIdentifier,
});
export type AccountLimitsAccount = typeof AccountLimitsAccount.Type;

export const AccountLimitsObservationSource = Schema.Literals(["event", "poll"]);
export type AccountLimitsObservationSource = typeof AccountLimitsObservationSource.Type;

export const AccountLimitsObservation = Schema.Struct({
  plan: Schema.NullOr(TrimmedNonEmptyString),
  windows: Schema.Array(AccountLimitsWindow),
  observedAt: Schema.String,
  source: AccountLimitsObservationSource,
});
export type AccountLimitsObservation = typeof AccountLimitsObservation.Type;

export const AccountLimitsAttempt = Schema.Struct({
  attemptedAt: Schema.String,
  status: Schema.Literals(["succeeded", "failed"]),
  error: Schema.NullOr(AccountLimitsErrorDetail),
});
export type AccountLimitsAttempt = typeof AccountLimitsAttempt.Type;

export const AccountLimitsSnapshot = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  account: Schema.optional(AccountLimitsAccount),
  observation: Schema.NullOr(AccountLimitsObservation),
  lastAttempt: AccountLimitsAttempt,
});
export type AccountLimitsSnapshot = typeof AccountLimitsSnapshot.Type;

export const AccountLimitsSummary = Schema.Struct({
  contractVersion: Schema.Number,
  readAt: Schema.String,
  snapshots: Schema.Array(AccountLimitsSnapshot),
});
export type AccountLimitsSummary = typeof AccountLimitsSummary.Type;

/**
 * Identity of one window across readings.
 *
 * The server merges windows by it, the client folds environments by it, and
 * React keys rows by it. Three copies of the formula is three chances for one
 * to drift and for the merge to silently stop matching.
 */
export function accountLimitsWindowKey(window: AccountLimitsWindow): string {
  return `${window.meter?.id ?? "primary"}:${window.id}`;
}
