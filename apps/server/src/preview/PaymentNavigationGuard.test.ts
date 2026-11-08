import { describe, expect, it } from "vite-plus/test";

import { paymentDomainOfUrl, paymentNavigationBlockedMessage } from "./PaymentNavigationGuard.ts";

const WALLETS = ["paypal.com", "pay.google.com"];

describe("paymentDomainOfUrl", () => {
  it("finds the payment domain of a document URL by its host alone", () => {
    expect(paymentDomainOfUrl("https://www.PayPal.com/checkoutnow?x=1", WALLETS)).toBe(
      "paypal.com",
    );
    expect(paymentDomainOfUrl("http://pay.google.com:8443/gp/p/ui/pay", WALLETS)).toBe(
      "pay.google.com",
    );
    expect(paymentDomainOfUrl("https://example.test/?next=https://paypal.com/", WALLETS)).toBe(
      undefined,
    );
  });

  it("treats lookalikes and unparsable URLs as no payment domain", () => {
    expect(paymentDomainOfUrl("https://notpaypal.com/", WALLETS)).toBeUndefined();
    expect(paymentDomainOfUrl("not a url", WALLETS)).toBeUndefined();
    expect(paymentDomainOfUrl("about:blank", WALLETS)).toBeUndefined();
  });
});

it("the blocked payment message names the domain and the takeover tool", () => {
  const message = paymentNavigationBlockedMessage("paypal.com");
  expect(message).toContain("paypal.com");
  expect(message).toContain("preview_request_takeover");
  expect(message).toMatch(/never buy, pay or confirm a purchase/);
});
