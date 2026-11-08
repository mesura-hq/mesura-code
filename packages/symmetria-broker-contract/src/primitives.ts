/**
 * Fork identifiers are re-exported so Symmetria and fork payloads agree by construction; they
 * emit a bare `{"type":"string"}` because `TrimmedNonEmptyString` loses its check in JSON Schema.
 * Symmetria-owned fields build on plain checked values, which keep the check through the brand.
 * `IsoDateTime` has no check upstream, so its bare emission is faithful: do not invent one.
 */
import * as Schema from "effect/Schema";

export { CommandId, EnvironmentId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";

/**
 * Every Symmetria numeric field builds on this one check, so all of them emit the same
 * constraint into the JSON Schema; a second copy edited alone would make them disagree.
 */
export const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * Not `TrimmedNonEmptyString`: its check sits after a transformation and is lost in JSON Schema.
 * Both checks here reach the artifact; the unanchored `\S` pattern refuses whitespace-only text.
 * It does not trim, so a padded document round-trips unchanged and golden fixtures stay exact.
 */
// Mesura: the `u` flag is load-bearing. Effect 4.0.2 emits a JSON Schema
// `pattern` only for a unicode-mode regex, and without it the artifact lost
// the whitespace-only check Symmetria Shell relies on.
export const NonEmptyText = Schema.String.check(Schema.isMinLength(1), Schema.isPattern(/\S/u));

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
