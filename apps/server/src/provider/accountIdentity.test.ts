import { assert, describe, it } from "@effect/vitest";
import { accountLimitsSubscriptionKey } from "@t3tools/contracts";

import { accountIdentityFromEmail } from "./accountIdentity.ts";

const claude = "anthropic" as const;
const codex = "openai" as const;

describe("accountIdentityFromEmail", () => {
  it("normalizes the key and keeps the address as the provider typed it", () => {
    assert.deepEqual(accountIdentityFromEmail(claude, "  Dev@Example.com "), {
      key: "anthropic:dev@example.com",
      label: "Dev@Example.com",
    });
  });

  it("keeps one address on two vendors apart", () => {
    // One person's Claude subscription and ChatGPT subscription can carry the
    // same address and are still two accounts. Folding them would report one
    // subscription's windows as the other's.
    const left = accountIdentityFromEmail(claude, "dev@example.com");
    const right = accountIdentityFromEmail(codex, "dev@example.com");
    assert.notEqual(left?.key, right?.key);
  });

  it("names no account when the provider named none", () => {
    // An identity invented from a missing address would fold every environment
    // that reported nothing into one row, which is worse than not folding.
    assert.equal(accountIdentityFromEmail(claude, undefined), undefined);
    assert.equal(accountIdentityFromEmail(claude, null), undefined);
    assert.equal(accountIdentityFromEmail(claude, 42), undefined);
    assert.equal(accountIdentityFromEmail(claude, "   "), undefined);
  });
});

describe("subscription namespaces", () => {
  it("names the vendor rather than the driver that read it", () => {
    // The driver is who read the number; the namespace is what is metered.
    // Keying by the reader is what split one subscription across two agents.
    assert.deepEqual(accountIdentityFromEmail("anthropic", "  Dev@Example.com "), {
      key: "anthropic:dev@example.com",
      label: "Dev@Example.com",
    });
  });

  it("builds its key through the contract's single formula", () => {
    assert.equal(
      accountIdentityFromEmail("openai", "Dev@Example.com")?.key,
      accountLimitsSubscriptionKey({ namespace: "openai", identifier: "dev@example.com" }),
    );
  });
});
