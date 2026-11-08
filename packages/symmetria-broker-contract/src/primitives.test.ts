import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { SymmetriaDraftVersion, SymmetriaSnapshotRevision } from "./primitives.ts";

/**
 * The bound must survive `Schema.brand` into the emitted JSON Schema. A transformed base such
 * as upstream `TrimmedString` drops the check from the artifact while TypeScript still enforces
 * it; these cases make that disagreement fail.
 */
const brandedNonNegativeIntegers = {
  SymmetriaDraftVersion,
  SymmetriaSnapshotRevision,
};

describe("Symmetria-owned branded primitives", () => {
  describe.each(Object.entries(brandedNonNegativeIntegers))("%s", (name, schema) => {
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

    it(`${name} preserves the safe-integer ceiling for JavaScript and JSON consumers`, () => {
      expect(Result.isSuccess(decode(Number.MAX_SAFE_INTEGER))).toBe(true);
      expect(Result.isFailure(decode(Number.MAX_SAFE_INTEGER + 1))).toBe(true);
      expect(Schema.toJsonSchemaDocument(schema).schema.maximum).toBe(Number.MAX_SAFE_INTEGER);
    });

    it(`${name} refuses a value that is not a number`, () => {
      expect(Result.isFailure(decode("1"))).toBe(true);
      expect(Result.isFailure(decode(null))).toBe(true);
    });
  });
});
