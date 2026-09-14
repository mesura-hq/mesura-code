import { expect, it } from "vitest";
import { decodeChangedEvent } from "../src/contract.ts";

it("decodes watch failure status and rejects malformed status", () => {
  expect(decodeChangedEvent({ subscriptionId: "s", error: "lost watch" })).toEqual({
    ok: true,
    value: { subscriptionId: "s", error: "lost watch" },
  });
  expect(decodeChangedEvent({ subscriptionId: "s", error: 42 }).ok).toBe(false);
});
