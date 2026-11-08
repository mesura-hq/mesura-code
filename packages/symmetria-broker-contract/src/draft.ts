/**
 * The composer draft of one thread and its compare-and-set rule. Semantics only: this package has
 * no store, so nothing enforces the rule at runtime. "Draft" means only the unsent composer
 * message (today client-side in `apps/web/src/composerDraftStore.ts`), never a pull-request draft.
 */
import { IsoDateTime, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { SymmetriaDraftSetCommand } from "./command.ts";
import { SymmetriaDraftVersion } from "./primitives.ts";

/**
 * One thread's composer draft. The body is `text` only: attachments (up to 10 MB each) are
 * excluded permanently, and selection fields wait for a command that can write them.
 * `version` is the only ordering a consumer may trust. `updatedAt` is an unvalidated string from
 * the writer's clock: sort by `version`, and render `updatedAt` only as a label.
 */
export const SymmetriaDraft = Schema.Struct({
  threadId: ThreadId,
  version: SymmetriaDraftVersion,
  updatedAt: IsoDateTime,
  text: Schema.String,
  // See `SymmetriaThreadSummary`: the identifier names this struct in the
  // emitted `$defs` instead of leaving it at a positional `Objects_3`.
}).annotate({ identifier: "SymmetriaDraft" });
export type SymmetriaDraft = typeof SymmetriaDraft.Type;

/**
 * A draft write is the draft-set command itself, so the compare-and-set rule has one wire shape.
 * `expectedVersion` is required because an optional expectation is last-write-wins.
 * `createdAt` lets `applySymmetriaDraftUpdate` stamp the applied draft without a clock.
 */
export const SymmetriaDraftUpdate = SymmetriaDraftSetCommand;
export type SymmetriaDraftUpdate = typeof SymmetriaDraftUpdate.Type;

/** The update matched the current version and the draft advanced by one. */
export const SymmetriaDraftUpdateApplied = Schema.Struct({
  outcome: Schema.Literal("applied"),
  draft: SymmetriaDraft,
});
export type SymmetriaDraftUpdateApplied = typeof SymmetriaDraftUpdateApplied.Type;

/**
 * Requires `currentVersion` to equal `currentDraft.version`. With a disagreeing pair, a consumer
 * that derives `expectedVersion` from the number conflicts on every retry. This cross-field rule
 * does not reach the emitted JSON Schema, so only the decoder enforces it.
 */
const conflictVersionAgreementFilter = Schema.makeFilter(
  ({
    currentVersion,
    currentDraft,
  }: {
    readonly currentVersion: number;
    readonly currentDraft: { readonly version: number };
  }) =>
    currentVersion === currentDraft.version ||
    `A draft conflict must report one version: currentVersion ${String(currentVersion)} contradicts currentDraft.version ${String(currentDraft.version)}.`,
);

/**
 * The update expected a version the draft is not at, so nothing was written. It carries the
 * current draft body so the losing surface can re-render. It is the producer's outcome, not the
 * command-channel answer: see `SymmetriaDraftUpdateResult`.
 */
export const SymmetriaDraftUpdateConflict = Schema.Struct({
  outcome: Schema.Literal("conflict"),
  currentVersion: SymmetriaDraftVersion,
  currentDraft: SymmetriaDraft,
}).check(conflictVersionAgreementFilter);
export type SymmetriaDraftUpdateConflict = typeof SymmetriaDraftUpdateConflict.Type;

/**
 * What a producer decides about one draft write. **It is not the command-channel answer.** A shell
 * gets a `SymmetriaCommandReceipt`, with `draft_version_conflict` on a refusal. The producer uses
 * this union to decide that receipt, and a draft delta carries its shape. A producer that answers
 * with both shapes loses the receipt's replay marker.
 */
export const SymmetriaDraftUpdateResult = Schema.Union([
  SymmetriaDraftUpdateApplied,
  SymmetriaDraftUpdateConflict,
]);
export type SymmetriaDraftUpdateResult = typeof SymmetriaDraftUpdateResult.Type;

/**
 * The successor of a draft version. The cast needs no check: the successor of a non-negative
 * integer is a non-negative integer.
 */
const nextDraftVersion = (version: SymmetriaDraftVersion): SymmetriaDraftVersion =>
  (version + 1) as SymmetriaDraftVersion;

/**
 * The later of two moments, so an applied draft never records a moment earlier than the one it
 * replaced. String comparison is exact for ISO-8601 UTC. It is a floor, not a validation:
 * `IsoDateTime` is a bare string. Consumers sort by `version`.
 */
const laterMoment = (left: string, right: string): string => (right > left ? right : left);

/**
 * The compare-and-set rule. Total: no clock, no store, no failure channel.
 * An update for another thread is refused as a conflict, so dictated words never land in a thread
 * nobody addressed. Only `expectedVersion === current.version` applies. A higher expectation is
 * refused too: it claims a version the producer never issued.
 */
export const applySymmetriaDraftUpdate = (
  current: SymmetriaDraft,
  update: SymmetriaDraftUpdate,
): SymmetriaDraftUpdateResult => {
  if (update.threadId !== current.threadId || update.expectedVersion !== current.version) {
    return {
      outcome: "conflict",
      currentVersion: current.version,
      currentDraft: current,
    };
  }
  return {
    outcome: "applied",
    draft: {
      threadId: current.threadId,
      version: nextDraftVersion(current.version),
      updatedAt: laterMoment(current.updatedAt, update.createdAt),
      text: update.text,
    },
  };
};

/**
 * Composer fields this draft refuses, as a value the privacy test asserts against. It mirrors
 * `SYMMETRIA_THREAD_SUMMARY_EXCLUDED_UPSTREAM_FIELDS`: a producer that builds a draft from the
 * client store can fold a transcript in by accident.
 */
export const SYMMETRIA_DRAFT_EXCLUDED_FIELDS = [
  // Transcript, under both of the names the fork gives it.
  "messages",
  "transcript",
  // The unbounded provider payload the contract forbids on the wire.
  "providerPayload",
  // Attachments, which the docstring above rules out permanently.
  "attachments",
  "images",
] as const;
