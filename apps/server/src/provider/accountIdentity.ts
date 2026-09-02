/**
 * Cross-environment identity for a provider subscription.
 *
 * Two environments that drive the same subscription report the same key, which
 * is what lets a client fold their readings into one row instead of listing the
 * same limits once per machine.
 *
 * The key names the vendor the subscription is metered against, not the driver
 * that read it. Two vendors are still kept apart when they share an address —
 * one person's Claude and ChatGPT subscriptions are two accounts — but one
 * subscription read through two different agents is one account, which keying
 * by driver could not express.
 *
 * @module provider/accountIdentity
 */
import {
  accountLimitsSubscriptionKey,
  type AccountLimitsAccount,
  type AccountLimitsNamespace,
} from "@t3tools/contracts";

/**
 * Build the identity for a subscription the provider named by email address.
 * Returns `undefined` when the provider reported no usable address, which
 * leaves the reading unfoldable rather than folding it into the wrong account.
 */
export function accountIdentityFromEmail(
  namespace: AccountLimitsNamespace,
  email: unknown,
): AccountLimitsAccount | undefined {
  if (typeof email !== "string") return undefined;
  const label = email.trim();
  if (label.length === 0) return undefined;
  return { key: accountLimitsSubscriptionKey({ namespace, identifier: label }), label };
}
