/**
 * The gate refuses an unsupported major and accepts any minor, because a minor bump is additive.
 * ⚠ Only a NEWER producer with an OLDER consumer is promised: a 1.0 snapshot lacks the required
 * `projects` array and fails to decode. That holds only while one producer ships with this
 * schema; revisit it FIRST if a producer that upgrades on its own schedule appears.
 */
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { NonNegativeInteger } from "./primitives.ts";

/** Semantic version of the whole contract surface, pinned by consumers. */
export const SYMMETRIA_CONTRACT_VERSION = "1.5.0";

/** The single major version this build of the contract speaks. */
export const SYMMETRIA_PROTOCOL_MAJOR = 1;

/** The highest minor version this build of the contract speaks. */
export const SYMMETRIA_PROTOCOL_MINOR = 5;

/**
 * A protocol version this build accepts. The major is pinned to a literal, so
 * decoding is itself the gate: an unsupported major never produces a value.
 */
// WORKAROUND: no `identifier` annotation, unlike every other shared struct. An annotated root
// emits as a bare `$ref`, which breaks `keeps every non-negative field aligned in generated JSON
// Schema` in tests/unit/symmetria-phase-one.test.ts. Add it once that test resolves a top-level
// `$ref` through `definitions`; the checksum then moves once, deliberately.
export const SymmetriaProtocolVersion = Schema.Struct({
  major: Schema.Literal(SYMMETRIA_PROTOCOL_MAJOR),
  minor: NonNegativeInteger,
});
export type SymmetriaProtocolVersion = typeof SymmetriaProtocolVersion.Type;

/**
 * A version pair as a peer announces it, before the gate runs. Kept separate
 * from `SymmetriaProtocolVersion` so a refusal can report the major it read
 * rather than only that the payload failed.
 */
export const AnnouncedProtocolVersion = Schema.Struct({
  major: NonNegativeInteger,
  minor: NonNegativeInteger,
});
export type AnnouncedProtocolVersion = typeof AnnouncedProtocolVersion.Type;

/** The peer speaks a major this build does not. */
export const SymmetriaProtocolVersionMismatch = Schema.TaggedStruct(
  "SymmetriaProtocolVersionMismatch",
  {
    supportedMajor: NonNegativeInteger,
    receivedMajor: NonNegativeInteger,
  },
);
export type SymmetriaProtocolVersionMismatch = typeof SymmetriaProtocolVersionMismatch.Type;

/** The peer sent something that is not a version pair at all. */
export const SymmetriaProtocolVersionMalformed = Schema.TaggedStruct(
  "SymmetriaProtocolVersionMalformed",
  {
    issue: Schema.String,
  },
);
export type SymmetriaProtocolVersionMalformed = typeof SymmetriaProtocolVersionMalformed.Type;

/** Every typed reason the version gate refuses a peer. */
export const SymmetriaProtocolVersionRejection = Schema.Union([
  SymmetriaProtocolVersionMismatch,
  SymmetriaProtocolVersionMalformed,
]);
export type SymmetriaProtocolVersionRejection = typeof SymmetriaProtocolVersionRejection.Type;

const decodeAnnounced = Schema.decodeUnknownResult(AnnouncedProtocolVersion);

/**
 * Runs the version gate over an announced version. A supported major yields the
 * version; anything else yields a typed rejection that names both majors, so a
 * caller can tell a peer what it would have had to speak.
 */
export const decodeSymmetriaProtocolVersion = (
  input: unknown,
): Result.Result<SymmetriaProtocolVersion, SymmetriaProtocolVersionRejection> => {
  const announced = decodeAnnounced(input);
  if (Result.isFailure(announced)) {
    return Result.fail({
      _tag: "SymmetriaProtocolVersionMalformed",
      issue: announced.failure.message,
    });
  }
  if (announced.success.major !== SYMMETRIA_PROTOCOL_MAJOR) {
    return Result.fail({
      _tag: "SymmetriaProtocolVersionMismatch",
      supportedMajor: SYMMETRIA_PROTOCOL_MAJOR,
      receivedMajor: announced.success.major,
    });
  }
  return Result.succeed({
    major: SYMMETRIA_PROTOCOL_MAJOR,
    minor: announced.success.minor,
  });
};
