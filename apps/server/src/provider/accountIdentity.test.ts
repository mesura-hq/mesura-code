import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import { accountIdentityFromEmail } from "./accountIdentity.ts";

const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");

describe("accountIdentityFromEmail", () => {
  it("normalizes the key and keeps the address as the provider typed it", () => {
    assert.deepEqual(accountIdentityFromEmail(claude, "  Dev@Example.com "), {
      key: "claudeAgent:dev@example.com",
      label: "Dev@Example.com",
    });
  });

  it("keeps one address on two providers apart", () => {
    // One person's Claude subscription and Codex subscription can carry the
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
