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

export const ACCOUNT_LIMITS_CONTRACT_VERSION = 2 as const;

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
 * The vendor account system a subscription is metered against.
 *
 * This is deliberately not the driver that read the numbers. One subscription
 * can be driven by more than one agent — a ChatGPT plan reached through Codex
 * and through OpenCode is one plan with one allowance — so keying by reader
 * would list it twice and halve the apparent spend of each row.
 */
export const AccountLimitsNamespace = Schema.Literals([
  "anthropic",
  "openai",
  "opencode-go",
  "zai",
]);
export type AccountLimitsNamespace = typeof AccountLimitsNamespace.Type;

/**
 * Identity of one subscription, across every environment and every reader.
 *
 * The only place this formula exists. The server writes keys with it and the
 * client groups rows by them, so a second copy is a second chance for the two
 * to disagree and for one subscription to render as two rows.
 *
 * The identifier is lowercased here rather than at each call site: vendors
 * report an address with whatever casing the user typed at signup, and two
 * environments must not disagree about the same account because of it.
 */
export function accountLimitsSubscriptionKey(input: {
  readonly namespace: AccountLimitsNamespace;
  readonly identifier: string;
}): string {
  return `${input.namespace}:${input.identifier.toLowerCase()}`;
}

/**
 * The provider instance a reading came through, when one did.
 *
 * Absent on a subscription polled directly against its vendor, which is why it
 * is optional rather than the identity it used to be.
 */
export const AccountLimitsReader = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
});
export type AccountLimitsReader = typeof AccountLimitsReader.Type;

/**
 * The subscription a reading belongs to. Always present.
 *
 * `key` identifies the subscription across environments: two environments that
 * report the same key share one account, so the client folds them into one row
 * instead of listing the same limits once per machine.
 *
 * A reading whose provider named no account still needs a key, and it gets an
 * unfoldable one — see `unfoldableInstanceSubscription`. Two machines reporting
 * no account are two machines, and folding them would report one's numbers as
 * the other's.
 */
export const AccountLimitsAccount = Schema.Struct({
  key: AccountLimitsIdentifier,
  label: AccountLimitsIdentifier,
});
export type AccountLimitsAccount = typeof AccountLimitsAccount.Type;

/**
 * Reserved prefix for a subscription key that must never be folded.
 *
 * No real key can collide with it: `accountLimitsSubscriptionKey` always starts
 * a key with a value from the closed `AccountLimitsNamespace` list.
 */
const UNFOLDABLE_SUBSCRIPTION_PREFIX = "#";

/**
 * The subscription of a reading whose provider named no account.
 *
 * The instance is the only identity available, and it is local to one machine,
 * so the key is marked unfoldable rather than shared.
 */
export function unfoldableInstanceSubscription(input: {
  readonly instanceId: string;
  readonly label?: string | undefined;
  /**
   * Which of the instance's readings this is, when it produced several.
   *
   * A reader that reports several subscriptions and names none of them would
   * otherwise give every one of them the same key, and each would overwrite the
   * last. Omit it for a reader that reports exactly one.
   */
  readonly ordinal?: number | undefined;
}): AccountLimitsAccount {
  const suffix = input.ordinal === undefined || input.ordinal === 0 ? "" : `:${input.ordinal}`;
  return {
    key: `${UNFOLDABLE_SUBSCRIPTION_PREFIX}instance:${input.instanceId}${suffix}`,
    label: input.label ?? input.instanceId,
  };
}

/**
 * What each vendor is called, wherever a subscription of theirs is shown.
 *
 * One map, because the server labels a discovered subscription with it and the
 * client titles the row with it. Two copies would drift, and the client decides
 * whether to repeat the label as a subtitle by comparing the two — a comparison
 * that is only sound while both sides say exactly the same thing.
 */
export const ACCOUNT_LIMITS_VENDOR_NAME: Readonly<Record<AccountLimitsNamespace, string>> = {
  anthropic: "Claude",
  openai: "ChatGPT",
  "opencode-go": "OpenCode Go",
  zai: "GLM Coding Plan",
};

/**
 * The vendor a subscription key names, or null when the key names no vendor.
 *
 * The namespace is already in the key, so reading it back is cheaper and
 * steadier than carrying it a second time on the wire. An unfoldable key names
 * an instance rather than a vendor and yields null.
 */
export function accountLimitsNamespaceOf(key: string): AccountLimitsNamespace | null {
  // Guard the separator explicitly. `indexOf` returns -1 when there is none,
  // and `slice(0, -1)` would then drop the last character rather than take the
  // whole string — which is how "openais" would answer "openai".
  const separator = key.indexOf(":");
  if (separator === -1) return null;
  const namespace = key.slice(0, separator);
  return AccountLimitsNamespace.literals.includes(namespace as AccountLimitsNamespace)
    ? (namespace as AccountLimitsNamespace)
    : null;
}

/** Whether two readings carrying this key may be folded into one row. */
export function isFoldableSubscriptionKey(key: string): boolean {
  return !key.startsWith(UNFOLDABLE_SUBSCRIPTION_PREFIX);
}

export const AccountLimitsObservationSource = Schema.Literals(["event", "poll"]);
export type AccountLimitsObservationSource = typeof AccountLimitsObservationSource.Type;

export const AccountLimitsObservation = Schema.Struct({
  plan: Schema.NullOr(TrimmedNonEmptyString),
  windows: Schema.Array(AccountLimitsWindow),
  observedAt: Schema.String,
  source: AccountLimitsObservationSource,
});
export type AccountLimitsObservation = typeof AccountLimitsObservation.Type;

/**
 * Why a read failed, from a closed set the client can branch on.
 *
 * `unrecognized` is the one that matters: it means the reading arrived and this
 * version of Mesura Code could not parse it, which is our bug rather than the
 * vendor's outage. Without the distinction the panel says "Refresh failed" for
 * a dead network and for a renamed field alike, and the two need opposite
 * responses.
 */
export const AccountLimitsFailureReason = Schema.Literals([
  "unreachable",
  "unauthorized",
  "unrecognized",
  "unknown",
]);
export type AccountLimitsFailureReason = typeof AccountLimitsFailureReason.Type;

export const AccountLimitsAttempt = Schema.Struct({
  attemptedAt: Schema.String,
  status: Schema.Literals(["succeeded", "failed"]),
  error: Schema.NullOr(AccountLimitsErrorDetail),
  /**
   * Why a failed read failed. Read it only where `status` is `failed`: the
   * schema does not tie the two together, so a reader that branches on it
   * alone would trust a reason beside a reading that succeeded.
   */
  reason: Schema.optional(AccountLimitsFailureReason),
});
export type AccountLimitsAttempt = typeof AccountLimitsAttempt.Type;

/**
 * One subscription's readings, whoever produced them.
 *
 * The subscription is the identity and the reader is a detail of provenance —
 * the inversion of what this carried at contract version 1, where the provider
 * instance was the identity and the subscription an optional decoration used
 * only for client-side folding.
 */
export const AccountLimitsSnapshot = Schema.Struct({
  subscription: AccountLimitsAccount,
  reader: Schema.optional(AccountLimitsReader),
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
