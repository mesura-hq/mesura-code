/**
 * The version gate for the Symmetria broker contract.
 *
 * A consumer opens a stream by announcing the protocol version it speaks. The
 * contract refuses an unsupported major outright and accepts any minor, because
 * a minor bump is additive by definition and a consumer that ignores unknown
 * fields keeps working across one. Phase five wires this gate into the stream
 * framing; here it only states the rule.
 *
 * ⚠ **The minor promise runs in one direction, and the 1.1 addition is what
 * made that worth saying out loud.** A NEWER producer talking to an OLDER
 * consumer is the case the rule describes and the case the contract handles:
 * unknown fields are dropped and an unknown stream entity degrades rather than
 * failing the payload. The reverse is not promised. `SymmetriaStreamSnapshot`
 * gained a required `projects` array in 1.1, so a snapshot from a genuine 1.0
 * producer now announces a minor this gate accepts and then fails to decode on
 * the missing key.
 *
 * That was a deliberate choice rather than an oversight, and it rests on a fact
 * about this deployment rather than on the shape of the contract: there is
 * exactly one producer, it ships in the same repository as its schema, and no
 * older one exists anywhere. An optional key would have bought nothing real and
 * cost every consumer a `?? []` at the point where it needs a project's name.
 * If a second producer ever appears — a phone, a server, anything that upgrades
 * on its own schedule — this is the decision to revisit FIRST, because the
 * failure mode is a stream that opens and then refuses its own opening item.
 */
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { NonNegativeInteger } from "./primitives.ts";

/** Semantic version of the whole contract surface, pinned by consumers. */
export const SYMMETRIA_CONTRACT_VERSION = "1.4.0";

/** The single major version this build of the contract speaks. */
export const SYMMETRIA_PROTOCOL_MAJOR = 1;

/** The highest minor version this build of the contract speaks. */
export const SYMMETRIA_PROTOCOL_MINOR = 4;

/**
 * A protocol version this build accepts. The major is pinned to a literal, so
 * decoding is itself the gate: an unsupported major never produces a value.
 */
// WORKAROUND: this struct carries no `identifier` annotation, and every other
// shared Symmetria struct does. What the annotation buys is a stable name in
// the emitted JSON Schema — `#/$defs/SymmetriaProtocolVersion` instead of the
// positional `#/$defs/Objects_` Effect falls back to. It is left off here
// because annotating a root makes `Schema.toJsonSchemaDocument` emit that
// root's own document as a bare `$ref` into `$defs`, and the approved test
// `keeps every non-negative field aligned in generated JSON Schema`
// (tests/unit/symmetria-phase-one.test.ts) reads
// `toJsonSchemaDocument(SymmetriaProtocolVersion).schema.properties.minor`
// directly and fails on the reference. Removing this once that test resolves a
// top-level `$ref` through `definitions`, the way the phase-five test already
// does, is the whole fix; the emitted key then changes and the checksum moves
// once, deliberately.
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
