import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Thread activities the Software Factory writes. Each is small and replaced in
 * place by id; document bodies never travel in them, only digests a client
 * reads back through `factoryReadSnapshot`.
 */
export const FACTORY_PLAN_ACTIVITY_KIND = "factory.plan";
export const FACTORY_RUN_ACTIVITY_KIND = "factory.run";
export const FACTORY_REPORT_ACTIVITY_KIND = "factory.report";
export const FACTORY_ACTIVITY_KINDS: ReadonlyArray<string> = [
  FACTORY_PLAN_ACTIVITY_KIND,
  FACTORY_RUN_ACTIVITY_KIND,
  FACTORY_REPORT_ACTIVITY_KIND,
];

/**
 * How many of a thread's newest Factory activities the server keeps past its
 * 500-activity window. A build buries its plan under about a thousand tool
 * calls, and each activity is replaced in place by id, so a few ids per plan
 * file and run cover a thread; the bound keeps a pathological thread finite.
 */
export const FACTORY_ACTIVITY_RETENTION_LIMIT = 16;

/** The sha256 of a stored document, as 64 lowercase hex characters. */
export const FACTORY_SNAPSHOT_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
export const FactorySnapshotDigest = Schema.String.check(
  Schema.isPattern(FACTORY_SNAPSHOT_DIGEST_PATTERN),
);
export type FactorySnapshotDigest = typeof FactorySnapshotDigest.Type;

export const isFactorySnapshotDigest = (value: string): value is FactorySnapshotDigest =>
  FACTORY_SNAPSHOT_DIGEST_PATTERN.test(value);

export const FactoryPlanActivityPhase = Schema.Struct({
  title: TrimmedNonEmptyString,
  acceptanceCount: NonNegativeInt,
});
export type FactoryPlanActivityPhase = typeof FactoryPlanActivityPhase.Type;

/** Payload of a `factory.plan` activity: enough to render a card, never the body. */
export const FactoryPlanActivityPayload = Schema.Struct({
  digest: FactorySnapshotDigest,
  intentDigest: FactorySnapshotDigest,
  planPath: TrimmedNonEmptyString,
  intentPath: TrimmedNonEmptyString,
  title: Schema.String,
  phases: Schema.Array(FactoryPlanActivityPhase),
  /** Every level-two heading of the plan, in document order. */
  headings: Schema.Array(Schema.String),
  presentedAt: IsoDateTime,
});
export type FactoryPlanActivityPayload = typeof FactoryPlanActivityPayload.Type;

export const FactoryReadSnapshotInput = Schema.Struct({
  /**
   * Any string on the wire: the server checks the digest's shape and answers a
   * malformed one with `FactoryReadSnapshotError` (`invalid-digest`). A
   * pattern here would fail in decoding instead, outside the declared error.
   */
  digest: Schema.String,
});
export type FactoryReadSnapshotInput = typeof FactoryReadSnapshotInput.Type;

/** A digest names fixed bytes, so a client may cache this answer forever. */
export const FactoryReadSnapshotResult = Schema.Struct({
  digest: FactorySnapshotDigest,
  markdown: Schema.String,
});
export type FactoryReadSnapshotResult = typeof FactoryReadSnapshotResult.Type;

const FACTORY_READ_SNAPSHOT_ERROR_MESSAGES = {
  "invalid-digest": "A snapshot digest is 64 lowercase hex characters.",
  "not-found": "No snapshot is stored under that digest.",
  "read-failed": "The snapshot could not be read.",
} as const;

export class FactoryReadSnapshotError extends Schema.TaggedError<FactoryReadSnapshotError>()(
  "FactoryReadSnapshotError",
  {
    reason: Schema.Literals(["invalid-digest", "not-found", "read-failed"]),
    digest: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return FACTORY_READ_SNAPSHOT_ERROR_MESSAGES[this.reason];
  }
}
