/**
 * The narrow read projection of one agent thread.
 *
 * `OrchestrationThread` (`packages/contracts/src/orchestration.ts:373`) is the
 * fork's own read model and is shaped for the fork's own screens: it embeds the
 * message transcript, the activity feed whose `payload` is `Schema.Unknown`,
 * the proposed plans and the checkpoints. None of that may cross to a shell, so
 * this module is an **allowlist** — every field it keeps is named here, and
 * everything else falls away because it was never named. Effect drops a key
 * this struct does not name, at every depth, in both directions: a payload
 * carrying one decodes without it, and encoding never puts one back.
 *
 * That dropping is not a substitute for the mapping. An upstream thread does
 * not decode as a summary unchanged — `OrchestrationThread` names its identity
 * `id` where this struct names it `threadId`, and carries no `tokenUsage` at
 * all, because token cost is `ThreadTokenUsageSnapshot`
 * (`providerRuntime.ts:309`) and reaches a producer separately. A producer
 * builds the summary field by field and relies on the dropping only as the
 * guard that catches what it did not mean to include.
 *
 * A thread is addressed by `threadId` and `projectId` and by nothing else. The
 * process id and the terminal pane slot that Symmetria Shell reads today are
 * exactly what this projection exists to replace: a slot number is reused, and
 * a reused address delivers a dictation to the wrong thread.
 *
 * Timestamps are `IsoDateTime` (`baseSchemas.ts:21`), which is a plain string
 * in this codebase, so a payload stays plain JSON in both directions.
 */
import {
  IsoDateTime,
  OrchestrationLatestTurn,
  OrchestrationSessionStatus,
  ProjectId,
  ThreadId,
  ThreadTokenUsageSnapshot,
  TrimmedNonEmptyString,
  TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * What the thread's provider session is doing, without saying anything about
 * the provider itself. `OrchestrationSession` (`orchestration.ts:299`) also
 * carries `providerName`, `providerInstanceId` and `lastError`; a shell needs
 * none of them to render a row, and `lastError` is free-form provider text.
 */
export const SymmetriaThreadLiveness = Schema.Struct({
  status: OrchestrationSessionStatus,
  activeTurnId: Schema.NullOr(TurnId),
});
export type SymmetriaThreadLiveness = typeof SymmetriaThreadLiveness.Type;

/**
 * The latest turn, minus two of the upstream fields. `sourceProposedPlan` is a
 * handle on transcript-shaped content, and a shell that lists threads never
 * follows it. `assistantMessageId` is a handle on one message of the
 * transcript, so publishing it would hand a shell an address inside exactly the
 * content this projection keeps out.
 *
 * `state` composes the upstream literal through `OrchestrationLatestTurn.fields`
 * rather than restating it. Upstream exports the struct value but keeps the
 * state literal module-private (`orchestration.ts:351`), and reaching it through
 * the struct's fields needs no copy and therefore no lock: there is only one
 * vocabulary, so nothing can drift out of step with it.
 */
export const SymmetriaThreadLatestTurn = Schema.Struct({
  turnId: TurnId,
  state: OrchestrationLatestTurn.fields.state,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type SymmetriaThreadLatestTurn = typeof SymmetriaThreadLatestTurn.Type;

/**
 * One thread, as a surface outside this fork sees it.
 *
 * Every field this struct declares itself is required on the wire. Upstream
 * marks several of them `Schema.optional` so payloads from older servers still
 * decode; the Symmetria contract is new, has no older producer to stay
 * compatible with, and a consumer reading `snoozedUntil` should not have to
 * tell "absent" from "null". A producer that projects an upstream thread
 * supplies `null` for an absent upstream value.
 *
 * `tokenUsage` is the one exception, and it is deliberate. It composes
 * `ThreadTokenUsageSnapshot` whole rather than restating its sixteen fields, so
 * it keeps upstream's own convention: `usedTokens` is required and every other
 * field is an optional key that is absent rather than null when the provider
 * did not report it. A consumer therefore reads absence inside `tokenUsage` and
 * null everywhere else, and phase six emits both conventions into the JSON
 * Schema. Restating the snapshot to make it uniform would put a second copy of
 * a sixteen-field vocabulary in this repository, which is the drift the whole
 * package is built to avoid.
 */
export const SymmetriaThreadSummary = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  // `worktreePath` is the name the tree already uses — `OrchestrationThread`
  // (orchestration.ts:388), `TerminalSessionSnapshot` (terminal.ts:100) and
  // `git.ts:82` all agree on it. Nullable because a thread need not run in a
  // worktree.
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
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
});
export type SymmetriaThreadSummary = typeof SymmetriaThreadSummary.Type;

/**
 * The upstream fields this projection deliberately refuses, kept as a value so
 * the privacy test asserts against a list rather than against three examples a
 * reader picked.
 *
 * Two kinds of name belong here. Most are a key of `OrchestrationThread` or of
 * a struct it embeds. The last two are not: `workspaceRoot` and `scripts` are
 * keys of `OrchestrationProject` and `OrchestrationProjectShell`
 * (`orchestration.ts:245` and `:442`), which a thread does not embed at all.
 * They are listed because a producer joining a thread to its project is exactly
 * where project configuration gets folded into a thread row by accident, and
 * the intent forbids project configuration on this wire.
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
