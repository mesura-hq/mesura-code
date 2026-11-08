/**
 * An **allowlist** projection of `OrchestrationThread`: Effect drops every unnamed key, at every
 * depth, in both directions. A producer still maps field by field; the dropping only catches
 * what it did not mean to include. A thread is addressed by `threadId` and `projectId` only:
 * a reused process id or pane slot would deliver a dictation to the wrong thread.
 */
import {
  IsoDateTime,
  ProjectId,
  ThreadId,
  ThreadTokenUsageSnapshot,
  TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { NonEmptyText } from "./primitives.ts";

/**
 * Mesura: frozen copies of `OrchestrationSessionStatus` and `OrchestrationLatestTurn`, which
 * upstream's orchestrator v2 deleted. The protocol owns them so the wire format and the
 * published JSON Schema stay unchanged; a producer maps v2 thread state onto them.
 */
export const SymmetriaSessionStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);
export type SymmetriaSessionStatus = typeof SymmetriaSessionStatus.Type;

export const SymmetriaLatestTurnState = Schema.Literals([
  "running",
  "interrupted",
  "completed",
  "error",
]);
export type SymmetriaLatestTurnState = typeof SymmetriaLatestTurnState.Type;

/**
 * What the thread's provider session is doing, without saying anything about
 * the provider itself. `OrchestrationSession` (`orchestration.ts:299`) also
 * carries `providerName`, `providerInstanceId` and `lastError`; a shell needs
 * none of them to render a row, and `lastError` is free-form provider text.
 */
export const SymmetriaThreadLiveness = Schema.Struct({
  status: SymmetriaSessionStatus,
  activeTurnId: Schema.NullOr(TurnId),
});
export type SymmetriaThreadLiveness = typeof SymmetriaThreadLiveness.Type;

/**
 * Omits `sourceProposedPlan` and `assistantMessageId`: both are handles into the transcript,
 * which this projection keeps out.
 */
export const SymmetriaThreadLatestTurn = Schema.Struct({
  turnId: TurnId,
  state: SymmetriaLatestTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type SymmetriaThreadLatestTurn = typeof SymmetriaThreadLatestTurn.Type;

/**
 * Every field declared here is required; a producer supplies `null` for an absent upstream value.
 * Exception: `tokenUsage` composes `ThreadTokenUsageSnapshot` whole, so its optional keys are
 * absent rather than null. A new optional snapshot field needs a `schema/` regeneration, not a
 * contract version bump.
 */
export const SymmetriaThreadSummary = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  // `NonEmptyText`, not upstream's `TrimmedNonEmptyString`: Effect drops upstream's check on
  // emission, so the artifact would call `""` a valid title while the decoder refuses it.
  // Accepted cost: these fields lose their brand and are not trimmed.
  title: NonEmptyText,
  branch: Schema.NullOr(NonEmptyText),
  // Nullable because a thread need not run in a worktree.
  worktreePath: Schema.NullOr(NonEmptyText),
  latestTurn: Schema.NullOr(SymmetriaThreadLatestTurn),
  session: Schema.NullOr(SymmetriaThreadLiveness),
  tokenUsage: Schema.NullOr(ThreadTokenUsageSnapshot),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  settledAt: Schema.NullOr(IsoDateTime),
  snoozedUntil: Schema.NullOr(IsoDateTime),
  pinnedAt: Schema.NullOr(IsoDateTime),
  deletedAt: Schema.NullOr(IsoDateTime),
  // Without the identifier Effect names a reused `$defs` entry by position (`Objects_1`), so
  // inserting a struct silently repoints a consumer's pinned pointer at a different shape.
}).annotate({ identifier: "SymmetriaThreadSummary" });
export type SymmetriaThreadSummary = typeof SymmetriaThreadSummary.Type;

/**
 * The upstream fields this projection refuses; the privacy test asserts this list.
 * `workspaceRoot` and `scripts` are project keys, listed because a producer that joins a thread
 * to its project can fold project configuration into a thread row by accident.
 */
export const SYMMETRIA_THREAD_SUMMARY_EXCLUDED_UPSTREAM_FIELDS = [
  // Transcript.
  "messages",
  // Activity feed, whose `payload` is `Schema.Unknown` — the unbounded provider
  // payload the contract forbids on the wire.
  "activities",
  "payload",
  // Plan markdown is transcript by another name.
  "proposedPlans",
  // Diff-shaped history a shell does not render.
  "checkpoints",
  // Provider identity and free-form provider error text.
  "providerName",
  "providerInstanceId",
  "lastError",
  // Project configuration, which carries scripts and environment values.
  "workspaceRoot",
  "scripts",
] as const;
