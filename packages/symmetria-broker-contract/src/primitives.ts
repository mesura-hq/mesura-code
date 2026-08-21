/**
 * The identifiers the Symmetria projection addresses things by.
 *
 * Where the fork already exports a branded identifier, this module re-exports
 * it rather than restating it, so a Symmetria payload and a fork payload agree
 * by construction. The identifiers Symmetria owns itself are declared here.
 *
 * Symmetria-owned numeric identifiers build on a plain checked integer rather
 * than on the upstream `TrimmedNonEmptyString` family. A check applied after
 * the transformation inside `TrimmedString` is dropped when the schema is
 * turned into JSON Schema, so a borrowed string identifier emits a bare
 * `{"type":"string"}` and a non-TypeScript consumer loses the constraint. A
 * plain checked value keeps its constraint through `Schema.brand`. Upstream
 * fields this projection composes keep whatever upstream chose — the loss only
 * matters for identifiers Symmetria defines.
 */
import * as Schema from "effect/Schema";

export { CommandId, EnvironmentId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";

/**
 * The one non-negative integer every Symmetria numeric field builds on. Shared
 * rather than restated: the check has to survive into the emitted JSON Schema,
 * and a second copy that somebody edits in isolation makes two fields of one
 * contract describe themselves differently to a consumer that is not
 * TypeScript.
 */
export const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * The one non-empty string every Symmetria text field builds on, and the string
 * counterpart of `NonNegativeInteger` above.
 *
 * `TrimmedNonEmptyString` cannot serve here. Its check is applied after a
 * transformation, so the emitted JSON Schema is a bare `{"type":"string"}` with
 * no constraint at all, and a consumer that is not TypeScript would be told a
 * whitespace-only dictation is valid and then have the decoder refuse it. Both
 * checks here sit directly on the string, so both reach the artifact:
 * `{"type":"string","allOf":[{"minLength":1},{"pattern":"\\S"}]}`.
 *
 * The pattern is what carries the *non-blank* half of the rule that trimming
 * used to carry. A JSON Schema `pattern` is an unanchored search, so `\S` says
 * "holds at least one character that is not whitespace" — the same values
 * `TrimmedNonEmptyString` refuses, refused for the same reason and in both
 * consumer kinds.
 *
 * It does not trim, and that is the second reason to prefer it. A trimming
 * codec is not the identity on the wire: a document with padded text decodes
 * and re-encodes to a different document, which is exactly what a golden
 * fixture exists to catch. What crosses the wire is what the producer wrote.
 */
export const NonEmptyText = Schema.String.check(Schema.isMinLength(1), Schema.isPattern(/\S/));

/**
 * The version of a thread's composer draft. Monotonic, and the value a
 * compare-and-set update states it expects.
 */
export const SymmetriaDraftVersion = NonNegativeInteger.pipe(Schema.brand("SymmetriaDraftVersion"));
export type SymmetriaDraftVersion = typeof SymmetriaDraftVersion.Type;

/**
 * The revision a snapshot carries. Every event stream opens with a snapshot, so
 * a consumer always has one of these before it sees a delta.
 */
export const SymmetriaSnapshotRevision = NonNegativeInteger.pipe(
  Schema.brand("SymmetriaSnapshotRevision"),
);
export type SymmetriaSnapshotRevision = typeof SymmetriaSnapshotRevision.Type;
