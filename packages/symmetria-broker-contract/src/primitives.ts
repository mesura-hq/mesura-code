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
 * plain checked value keeps its constraint through `Schema.brand`.
 *
 * ⚠ The scope of that mitigation was widened on 2026-08-22, and the sentence
 * this replaces said the opposite: it claimed upstream fields this projection
 * composes keep whatever upstream chose, because the loss only mattered for
 * identifiers Symmetria defines. That held while nothing outside TypeScript
 * read the artifacts. Symmetria Shell now does, and the field it renders is
 * `SymmetriaThreadSummary.title`, so the three free-text fields of the thread
 * summary are declared on `NonEmptyText` instead — see the comment at their
 * declaration. Issue #2.
 *
 * Two things deliberately did NOT move with them, and the reasons are separate:
 *
 * - **Timestamps.** Measured the same day: `IsoDateTime`
 *   (`packages/contracts/src/baseSchemas.ts:21`) is `Schema.String` with no
 *   check at all. A bare `{"type":"string"}` for a timestamp is therefore a
 *   faithful emission, not a dropped constraint, and there is nothing to
 *   restore. Inventing one would make this projection refuse timestamps the
 *   fork itself accepts. `upstreamDerivedConstraints.test.ts` guards against
 *   that edit; issue #2's body assumes the opposite and is wrong on this point.
 * - **The re-exported entity identifiers.** `ThreadId`, `ProjectId`, `TurnId`
 *   and `CommandId` are `TrimmedNonEmptyString` underneath, so they emit bare
 *   too. Declaring Symmetria copies of them would cost the brand and the
 *   by-construction agreement with fork payloads, which is a larger trade than
 *   a rendered label is worth. Recorded on issue #2 as what stays open.
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
