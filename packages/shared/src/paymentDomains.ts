const normalizeDomain = (domain: string) =>
  domain.trim().toLowerCase().replace(/^\.+/, "").replace(/\.$/, "");

/** The listed payment domain that `host` is or sits under; cookie-style leading dots match too. */
export function matchPaymentDomain(
  host: string,
  paymentDomains: ReadonlyArray<string>,
): string | undefined {
  const normalizedHost = normalizeDomain(host);
  if (normalizedHost === "") return undefined;
  return paymentDomains
    .map(normalizeDomain)
    .find(
      (domain) =>
        domain !== "" && (normalizedHost === domain || normalizedHost.endsWith(`.${domain}`)),
    );
}
