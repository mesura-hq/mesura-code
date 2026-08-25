/**
 * Cross-environment identity for a provider subscription.
 *
 * Two environments that drive the same subscription report the same key, which
 * is what lets a client fold their readings into one row instead of listing the
 * same limits once per machine. The driver is part of the key because one
 * person's Claude subscription and Codex subscription can carry the same
 * address and are still two separate accounts.
 *
 * @module provider/accountIdentity
 */
import type { AccountLimitsAccount, ProviderDriverKind } from "@t3tools/contracts";

/**
 * Build the identity for a subscription the provider named by email address.
 * Returns `undefined` when the provider reported no usable address, which
 * leaves the reading unfoldable rather than folding it into the wrong account.
 */
export function accountIdentityFromEmail(
  driver: ProviderDriverKind,
  email: unknown,
): AccountLimitsAccount | undefined {
  if (typeof email !== "string") return undefined;
  const label = email.trim();
  if (label.length === 0) return undefined;
  return { key: `${driver}:${label.toLowerCase()}`, label };
}
