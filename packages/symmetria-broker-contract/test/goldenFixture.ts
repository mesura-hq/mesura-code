/**
 * Loading and round-tripping the checked-in golden fixtures.
 *
 * A golden fixture pins the **encoded** shape, which is the only shape a
 * consumer outside TypeScript ever sees. Asserting both directions is what
 * makes it a pin rather than a sample: the fixture has to decode, and encoding
 * what it decoded to has to reproduce the document byte for byte, including its
 * key order and its two-space indentation. A field that silently reorders,
 * renames or drops on the way out fails here.
 *
 * Shared rather than restated per module, because every later phase pins its
 * own roots the same way.
 */
// @effect-diagnostics nodeBuiltinImport:off - a test helper reads fixtures off
// disk directly; pulling in the Effect `FileSystem` layer to read two files
// would make every assertion effectful for nothing.
import * as NodeFS from "node:fs";

import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

export const readGoldenFixtureSource = (name: string): string =>
  NodeFS.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

export const readGoldenFixture = (name: string): Record<string, unknown> =>
  JSON.parse(readGoldenFixtureSource(name)) as Record<string, unknown>;

/** The exact serialization every golden fixture on disk is written with. */
export const formatGoldenDocument = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

// The `as never` casts follow `ForwardCompatibleArray` in
// `packages/contracts/src/baseSchemas.ts`: a helper generic over `Schema.Top`
// cannot prove to the codec that the schema needs no decoding or encoding
// services, and every Symmetria root is a plain synchronous codec.
export const expectGoldenRoundTrip = <S extends Schema.Top>(schema: S, name: string): S["Type"] => {
  const source = readGoldenFixtureSource(name);
  const decoded = Schema.decodeUnknownSync(schema as never)(JSON.parse(source)) as S["Type"];
  const encoded = Schema.encodeSync(schema as never)(decoded as never);
  expect(formatGoldenDocument(encoded)).toBe(source);
  return decoded;
};
