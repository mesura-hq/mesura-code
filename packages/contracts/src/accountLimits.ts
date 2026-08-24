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
});
export type AccountLimitsWindow = typeof AccountLimitsWindow.Type;

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
