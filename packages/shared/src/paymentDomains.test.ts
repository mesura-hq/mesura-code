import { describe, expect, it } from "vite-plus/test";

import { matchPaymentDomain } from "./paymentDomains.ts";

const WALLETS = ["paypal.com", "checkout.stripe.com", "mercadopago.com.ar"];

describe("matchPaymentDomain", () => {
  it("matches a listed payment domain exactly and through its subdomains", () => {
    expect(matchPaymentDomain("paypal.com", WALLETS)).toBe("paypal.com");
    expect(matchPaymentDomain("www.paypal.com", WALLETS)).toBe("paypal.com");
    expect(matchPaymentDomain("a.b.checkout.stripe.com", WALLETS)).toBe("checkout.stripe.com");
  });

  it("ignores case, a leading cookie dot and a trailing root dot on either side", () => {
    expect(matchPaymentDomain("WWW.PayPal.COM", WALLETS)).toBe("paypal.com");
    expect(matchPaymentDomain(".paypal.com", WALLETS)).toBe("paypal.com");
    expect(matchPaymentDomain("paypal.com.", WALLETS)).toBe("paypal.com");
    expect(matchPaymentDomain("www.mercadopago.com.ar", [" .MercadoPago.com.ar "])).toBe(
      "mercadopago.com.ar",
    );
  });

  it("does not match lookalike hosts, parent domains or empty input", () => {
    expect(matchPaymentDomain("notpaypal.com", WALLETS)).toBeUndefined();
    expect(matchPaymentDomain("paypal.com.example.test", WALLETS)).toBeUndefined();
    expect(matchPaymentDomain("stripe.com", WALLETS)).toBeUndefined();
    expect(matchPaymentDomain("js.stripe.com", WALLETS)).toBeUndefined();
    expect(matchPaymentDomain("", WALLETS)).toBeUndefined();
    expect(matchPaymentDomain("paypal.com", ["", "."])).toBeUndefined();
  });
});
