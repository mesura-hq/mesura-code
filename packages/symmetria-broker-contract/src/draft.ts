/**
 * The thread's composer draft, and the compare-and-set rule that keeps two
 * surfaces from overwriting each other.
 *
 * **This module defines semantics, and nothing here enforces them at runtime.**
 * The same caveat the command module carries applies: there is no store in this
 * package, so a green suite proves the contract can *express* compare-and-set,
 * not that any producer honours it. A producer built on this contract owes the
 * rule `applySymmetriaDraftUpdate` states.
 *
 * The word "draft" is ambiguous in this repository and this module means only
 * one of its senses: the unsent composer message of one thread, which today
 * lives client-side in `apps/web/src/composerDraftStore.ts` with no wire shape
 * and no version field at all. That is why compare-and-set matters here and
 * nowhere else — the desktop and a shell will both edit one thread's draft, and
 * today nothing arbitrates between them. `PullRequestReviewCommentDraft`
 * (`packages/contracts/src/pullRequest.ts:884`) and the `isDraft` booleans
 * beside it are pull-request drafts and share nothing with this but the word.
 *
 * The gap is measured: a grep for `expectedVersion` across `packages/contracts`
 * returns no file. Compare-and-set exists nowhere in the fork's contracts, so
 * this is the one part of the projection that is new vocabulary rather than a
 * borrow, and it has no upstream name to keep in step with.
 */
import { IsoDateTime, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { SymmetriaDraftSetCommand } from "./command.ts";
import { SymmetriaDraftVersion } from "./primitives.ts";

/**
 * One thread's composer draft as a surface outside this fork sees it.
 *
 * The body is `text` and nothing else, which is narrower than the client store
 * it projects. That store also holds a `ModelSelection`, a `RuntimeMode`, a
 * `ProviderInteractionMode` and image attachments. None of the four belongs
 * here yet:
 *
 * - Attachments are excluded outright and permanently. `ChatImageAttachment`
 *   (`orchestration.ts:173`) admits an image up to
 *   `PROVIDER_SEND_TURN_MAX_IMAGE_BYTES` — 10 MB — and
 *   `UploadChatImageAttachment` (`:182`) a data URL of fourteen million
 *   characters. A projection a shell polls cannot carry those.
 * - The three selections are excluded because `SymmetriaDraftSetCommand` is the
 *   only writer this contract has and it carries text alone, so a selection
 *   field would be a slot no command can fill. Adding one is additive and
 *   belongs with the command that writes it.
 *
 * `version` is monotonic and is the whole of what an update compares against.
 * **It is also the only ordering a consumer may trust.** `updatedAt` is
 * `IsoDateTime` (`baseSchemas.ts:21`), which is a bare `Schema.String` in this
 * codebase — it keeps a draft plain JSON in both directions, and it means any
 * string decodes. The producer states it from the writer's own clock, so a
 * shell with clock skew, or one that stamps a command when the user started
 * typing rather than when it sent, can state a moment earlier than the draft it
 * replaced. `applySymmetriaDraftUpdate` never lets the recorded moment go
 * backwards, but that is a floor and not a validation: sort a thread list by
 * `version`, and render `updatedAt` only as a label.
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
 * A draft write, which *is* the draft-set command and not a second struct
 * beside it.
 *
 * Two wire shapes for one write would state the compare-and-set rule twice, and
 * two statements of one rule drift. So this is an alias: the command a shell
 * sends is the update a producer applies, and `expectedVersion` is required on
 * it because an optional expectation is last-write-wins wearing a version
 * field.
 *
 * The update carries `createdAt`, which is what lets `applySymmetriaDraftUpdate`
 * stamp an applied draft without holding a clock.
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
 * The two agree on the version, and the schema refuses a pair that does not.
 *
 * The restatement is deliberate — a consumer branches on `currentVersion`
 * without reaching into a nested struct — but a restated fact that nothing
 * checks is a fact that drifts. A producer building the conflict from its own
 * counter beside a cached draft can state 99 over a draft at 7, and a consumer
 * that computes its next `expectedVersion` from the number then conflicts on
 * every retry forever. The filter follows `viewportAreaFilter`
 * (`packages/contracts/src/preview.ts:37`), which is the fork's own idiom for a
 * rule that spans two fields of one struct.
 *
 * Measured limit: a rule spanning two fields does not survive into the emitted
 * JSON Schema, so this one is a decode-time guarantee and a consumer validating
 * a conflict against the artifact will not catch a disagreeing pair. That is
 * the reverse of the `NonEmptyText` case in `primitives.ts`, where the
 * constraint had to reach the artifact: here the decoder is the only reader
 * that can enforce it at all.
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
 * The update expected a version the draft is not at, so nothing was written.
 *
 * It carries the current draft body and not only the current number, so the
 * surface that lost the race can re-render from what it was handed. Note where
 * that body travels: this union is the producer's own outcome, not the answer
 * on the command channel — see `SymmetriaDraftUpdateResult` below.
 */
export const SymmetriaDraftUpdateConflict = Schema.Struct({
  outcome: Schema.Literal("conflict"),
  currentVersion: SymmetriaDraftVersion,
  currentDraft: SymmetriaDraft,
}).check(conflictVersionAgreementFilter);
export type SymmetriaDraftUpdateConflict = typeof SymmetriaDraftUpdateConflict.Type;

/**
 * What a producer decides about one draft write.
 *
 * **This is the producer's outcome, and it is not the answer on the command
 * channel.** A shell sends `thread.draft.set` and is answered by
 * `SymmetriaCommandReceipt`; a refused write carries the
 * `draft_version_conflict` code (`command.ts:229`) on that receipt. This union
 * is what a producer computes in order to decide the receipt, and it is the
 * shape a draft delta carries. Saying which channel answers is the point of
 * this paragraph: two shapes side by side with nothing choosing between them is
 * how a producer ends up emitting both, and how the replay marker that makes a
 * duplicated command safe goes missing from the answer a caller actually reads.
 *
 * So the loser of a race learns the current draft the way it learns everything
 * else about the thread — from the stream it already holds — and not from a
 * second request. Phase five frames that stream.
 */
export const SymmetriaDraftUpdateResult = Schema.Union([
  SymmetriaDraftUpdateApplied,
  SymmetriaDraftUpdateConflict,
]);
export type SymmetriaDraftUpdateResult = typeof SymmetriaDraftUpdateResult.Type;

/**
 * The successor of a draft version.
 *
 * The cast is the repository's own idiom for building a branded value outside a
 * decoder (`apps/server/src/orchestration/threadDetailCursor.ts:61`) and it is
 * sound here without a check: `SymmetriaDraftVersion` is a non-negative
 * integer, and the successor of one is another.
 */
const nextDraftVersion = (version: SymmetriaDraftVersion): SymmetriaDraftVersion =>
  (version + 1) as SymmetriaDraftVersion;

/**
 * The later of two recorded moments, so an applied draft never records a moment
 * earlier than the draft it replaced.
 *
 * A plain string comparison, which is exact for the ISO-8601 UTC form every
 * producer in this fork writes and is the reason the projection carries
 * `IsoDateTime` rather than a decoded instant. It is a floor and not a
 * validation: `IsoDateTime` is a bare `Schema.String`, so a producer that
 * states a malformed moment gets that string back. `version` is the ordering
 * every consumer sorts by, and `SymmetriaDraft` says so.
 */
const laterMoment = (left: string, right: string): string => (right > left ? right : left);

/**
 * The compare-and-set rule, as code rather than as prose a producer may read
 * differently.
 *
 * Total: it holds no clock, no store and no failure channel, and it answers
 * every pair of inputs with one member of the result union.
 *
 * Two things have to hold before a write lands, and the address is checked
 * first. An update names the thread it is for, and this function is the one
 * place in the package that can see that name beside the draft's own. Applying
 * an update addressed elsewhere would land dictated words in a thread nobody
 * addressed, which is the exact failure this whole projection exists to remove,
 * so a mismatch is refused. It is refused as a conflict rather than as new
 * vocabulary because a conflict already says the true thing — nothing was
 * written, and here is the draft that stands — and `currentDraft.threadId`
 * shows the caller which thread it was actually looking at.
 *
 * Then exactly one version ordering applies: the expectation equal to the
 * current version. A *lower* expectation is the stale writer everybody
 * pictures. A *higher* one is refused for the same reason and it is the case
 * worth stating: a caller claiming a version the producer has never issued
 * knows less about this draft than a stale caller does, and accepting it would
 * write a body derived from a draft that never existed.
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
 * The composer fields this draft deliberately refuses, kept as a value so the
 * privacy test asserts against a list rather than against three examples a
 * reader picked. It mirrors
 * `SYMMETRIA_THREAD_SUMMARY_EXCLUDED_UPSTREAM_FIELDS` and exists for the same
 * reason: a producer building a draft from the client store is where a
 * transcript gets folded in by accident.
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
