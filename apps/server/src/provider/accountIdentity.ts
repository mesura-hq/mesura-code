/**
 * Cross-environment identity for a provider subscription, so a client folds two machines'
 * readings of one subscription into one row. The key names the vendor the subscription is
 * metered against, not the driver that read it: one subscription read by two agents is one
 * account, and one person's Claude and ChatGPT subscriptions stay two.
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
