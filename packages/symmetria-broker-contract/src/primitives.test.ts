import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { SymmetriaDraftVersion, SymmetriaSnapshotRevision } from "./primitives.ts";

/**
 * The bound on these two has to survive `Schema.brand`, because phase six emits
 * JSON Schema from them and a non-TypeScript consumer only ever sees what
 * survives. Rebuilding either on a transformed base — the upstream
 * `TrimmedString` family, say — drops the check from the emitted document while
 * TypeScript keeps enforcing it, so the two consumer kinds would disagree with
 * nothing red. These cases are what turns that back into a failure.
 */
const brandedNonNegativeIntegers = {
  SymmetriaDraftVersion,
  SymmetriaSnapshotRevision,
};

describe("Symmetria-owned branded primitives", () => {
  for (const [name, schema] of Object.entries(brandedNonNegativeIntegers)) {
    const decode = Schema.decodeUnknownResult(schema);

    it(`${name} accepts zero and positive integers`, () => {
      expect(Result.isSuccess(decode(0))).toBe(true);
      expect(Result.isSuccess(decode(7))).toBe(true);
    });

    it(`${name} refuses negative integers`, () => {
      expect(Result.isFailure(decode(-1))).toBe(true);
      expect(Result.isFailure(decode(-2))).toBe(true);
    });

    it(`${name} refuses a fractional value`, () => {
      expect(Result.isFailure(decode(1.5))).toBe(true);
    });

    it(`${name} refuses a value that is not a number`, () => {
      expect(Result.isFailure(decode("1"))).toBe(true);
      expect(Result.isFailure(decode(null))).toBe(true);
    });
  }
});
