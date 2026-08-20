/**
 * What a surface outside this fork may ask of one thread, and what it is told
 * in return.
 *
 * **This module defines semantics, and nothing here enforces them at runtime.**
 * There is no store, no dispatcher and no reactor in this package, so a green
 * suite proves that the contract can *express* idempotency, not that any system
 * honours it. A producer built on this contract owes the guarantee the receipt
 * describes: for one `commandId`, one effect and a second identical receipt.
 *
 * The idempotency key is `CommandId`, borrowed rather than invented. Upstream
 * already settled that the correlation key and the command key are one thing —
 * `CorrelationId = CommandId` at `packages/contracts/src/orchestration.ts:164`,
 * with the comment "Correlation id is command id by design in this model" — so
 * a Symmetria `clientRequestId` would be a second name for a fact this fork has
 * already named.
 *
 * The measured gap this module closes is `DispatchResult`
 * (`orchestration.ts:1566`), which is `{ sequence }` and nothing else: two
 * dispatches of one `commandId` return two sequence numbers, and no consumer
 * can tell a replay from a fresh command. `OrchestrationCommandReceiptStatus`
 * (`orchestration.ts:1507`) names "accepted" and "rejected" but nothing
 * references it from a dispatch result.
 */
import {
  ClientActivityClientId,
  CommandId,
  IsoDateTime,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { NonEmptyText, NonNegativeInteger, SymmetriaDraftVersion } from "./primitives.ts";
import { SymmetriaProtocolVersion } from "./version.ts";

/**
 * The block every command shares, spread into each member the way
 * `EventBaseFields` (`orchestration.ts:1331`) spreads into every member of
 * `OrchestrationEvent`. Declared once so a member cannot quietly grow its own
 * spelling of an address.
 *
 * `threadId` is the whole of a command's target. No process id, no window
 * handle, no pane slot and no route string: a slot number is reused as panes
 * come and go, and a reused address is what delivers a dictation to the wrong
 * thread. No `EnvironmentId` joins it either — this projection is one
 * environment's, the same as the thread summary and the stream snapshot, and a
 * later multi-environment run adds the field to all three together.
 */
const CommandBaseFields = {
  commandId: CommandId,
  threadId: ThreadId,
  protocolVersion: SymmetriaProtocolVersion,
  createdAt: IsoDateTime,
} as const;

/**
 * New words for one thread. The narrow half of `ThreadTurnStartCommand`
 * (`orchestration.ts:825`): no attachments, because the upstream attachment
 * schemas admit a 10 MB image and a 14-million-character data URL and a shell
 * that polls a projection cannot carry those; and no model or runtime
 * selection, because a shell dictating into a thread inherits whatever that
 * thread already runs.
 *
 * `text` is `NonEmptyText` rather than the upstream `TrimmedNonEmptyString`.
 * Upstream's own turn text is a bare `Schema.String`
 * (`orchestration.ts:832`), so the non-empty rule is Symmetria's own addition
 * and not a borrowed constraint — and an addition has to survive into the
 * emitted JSON Schema, or a shell validates a whitespace-only dictation as good
 * and then watches the broker refuse the turn.
 */
export const SymmetriaTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  ...CommandBaseFields,
  text: NonEmptyText,
});
export type SymmetriaTurnStartCommand = typeof SymmetriaTurnStartCommand.Type;

/**
 * Stop what the thread is doing. `turnId` is nullable rather than optional:
 * naming the turn interrupts that turn and nothing else, and null means "the
 * turn that is running now", which is what a shell has when it saw a row light
 * up but never learned the turn's identity.
 */
export const SymmetriaTurnInterruptCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.interrupt"),
  ...CommandBaseFields,
  turnId: Schema.NullOr(TurnId),
});
export type SymmetriaTurnInterruptCommand = typeof SymmetriaTurnInterruptCommand.Type;

/**
 * Replace the thread's composer draft, stating the version the caller believed
 * it was replacing. The compare-and-set semantics, the draft body and the typed
 * conflict are phase four's; what this command owes is the `expectedVersion`
 * field, because a draft set that cannot state its expectation is the silent
 * overwrite the contract exists to refuse.
 *
 * Phase four should make `SymmetriaDraftUpdate` *be* this body rather than a
 * second struct beside it. Two wire shapes for one draft write would state the
 * compare-and-set rule in two places, and two statements of one rule drift.
 *
 * `text` is a bare `Schema.String` on purpose, unlike a turn's: emptying the
 * composer is a legitimate draft, and refusing it would leave a shell no way to
 * clear what it wrote.
 */
export const SymmetriaDraftSetCommand = Schema.Struct({
  type: Schema.Literal("thread.draft.set"),
  ...CommandBaseFields,
  text: Schema.String,
  expectedVersion: SymmetriaDraftVersion,
});
export type SymmetriaDraftSetCommand = typeof SymmetriaDraftSetCommand.Type;

/**
 * Reveal one exact thread on a surface.
 *
 * The fork owns both halves of this verb already. `DesktopWindow.activate`
 * (`apps/desktop/src/window/DesktopWindow.ts:83`) reveals the current main
 * window or creates one, and `buildAgentAwarenessDeepLink`
 * (`packages/shared/src/agentAwareness.ts:46`) points an outside surface at one
 * thread by identity. So activation addresses a thread, never a window: the
 * `threadId` on the shared block is the target, and this member adds only the
 * optional question of *which* surface should do the revealing.
 *
 * `targetSurfaceId` is `ClientActivityClientId` (`background.ts:64`) — the same
 * id `SymmetriaSurfacePresence` publishes as `clientId`, so a named target is
 * checkable against a presence row before the command is sent. It is an
 * optional key rather than a nullable one: with no surface named the resolver
 * picks one, and its choice is what the receipt reports back.
 *
 * A duplicate activation needs its single effect stated, because unlike a turn
 * or a draft version it has no obvious one. The effect is that the named thread
 * becomes the selected thread on the activated surface, and that surface is
 * revealed once. A replay of the same `commandId` after a dropped connection
 * re-reports that outcome; it is never a second reveal. A user who means to
 * activate twice sends two command ids.
 */
export const SymmetriaActivateCommand = Schema.Struct({
  type: Schema.Literal("thread.activate"),
  ...CommandBaseFields,
  targetSurfaceId: Schema.optionalKey(ClientActivityClientId),
});
export type SymmetriaActivateCommand = typeof SymmetriaActivateCommand.Type;

/**
 * Every command tag a surface outside this fork may send, as a value so a
 * consumer can branch on the list rather than on examples.
 *
 * Four, deliberately, against the 23 members of
 * `DispatchableClientOrchestrationCommand` (`orchestration.ts:912`). This is a
 * shell-facing contract and not a mirror of the app's command surface: the
 * other 19 verbs — creating projects, archiving, snoozing, answering approvals,
 * reverting checkpoints — belong to a client that renders the app's own
 * screens. Widening this set later is additive; narrowing it after a consumer
 * ships is not, which is the whole argument for stopping at four.
 *
 * The two tags upstream already owns keep their upstream spelling. The two
 * Symmetria adds follow the same dotted style.
 */
export const SYMMETRIA_COMMAND_TYPES = [
  "thread.turn.start",
  "thread.turn.interrupt",
  "thread.draft.set",
  "thread.activate",
] as const;
export type SymmetriaCommandType = (typeof SYMMETRIA_COMMAND_TYPES)[number];

/** One instruction, addressed to one thread, carrying its own idempotency key. */
export const SymmetriaCommandEnvelope = Schema.Union([
  SymmetriaTurnStartCommand,
  SymmetriaTurnInterruptCommand,
  SymmetriaDraftSetCommand,
  SymmetriaActivateCommand,
]);
export type SymmetriaCommandEnvelope = typeof SymmetriaCommandEnvelope.Type;

/**
 * Whether this receipt reports the command's first application or repeats what
 * an earlier application already produced.
 *
 * This marker is the *only* field on which two receipts for one `commandId` may
 * differ. Everything else — the effect identity, the accepted sequence, the
 * refusal — is what the first application decided, and a replay restates it
 * rather than deciding again.
 */
export const SymmetriaCommandApplication = Schema.Literals(["first", "replay"]);
export type SymmetriaCommandApplication = typeof SymmetriaCommandApplication.Type;

/**
 * What an applied command brought into being, as one flat struct rather than a
 * union keyed on the command that produced it.
 *
 * Flat on purpose: the guarantee under this whole module is a single deep
 * equality between two receipts, and a shape that varied by command would make
 * that comparison depend on which command was replayed. So every command
 * reports every slot, and the slots it did not fill are null.
 *
 * A turn start fills `turnId` with the turn it opened. An interrupt fills the
 * same slot with the turn it stopped, which is the resolution of a null
 * `turnId` on the command and the one fact the caller did not have when it
 * asked. A draft set fills `draftVersion` with the version it wrote. An
 * activation fills `activatedSurfaceId` with the surface that performed the
 * reveal, which is the answer to an activation that named no target.
 */
export const SymmetriaCommandEffect = Schema.Struct({
  turnId: Schema.NullOr(TurnId),
  draftVersion: Schema.NullOr(SymmetriaDraftVersion),
  activatedSurfaceId: Schema.NullOr(ClientActivityClientId),
});
export type SymmetriaCommandEffect = typeof SymmetriaCommandEffect.Type;

/**
 * Why a command was refused, as a closed vocabulary rather than free-form text.
 *
 * The literal-union-of-reasons follows `ProjectEntriesFailure`
 * (`packages/contracts/src/project.ts:84`), which is the fork's own idiom for a
 * failure a caller branches on. `detail` is the human sentence beside it and
 * nothing may branch on it. The key is always present and carries `null` when
 * there is no sentence to add — it is nullable, not optional, so a consumer
 * reads one shape rather than telling an absent key from a null one. Its
 * `NonEmptyText` makes the same rule as a turn's text reach a consumer that is
 * not TypeScript: a `detail` present but empty says nothing and is refused.
 */
export const SymmetriaCommandRejectionCode = Schema.Literals([
  "unknown_thread",
  "thread_deleted",
  "no_turn_running",
  "draft_version_conflict",
  "surface_not_attached",
  "no_surface_available",
  "command_not_supported",
]);
export type SymmetriaCommandRejectionCode = typeof SymmetriaCommandRejectionCode.Type;

/** The typed reason a refused receipt carries. */
export const SymmetriaCommandRejection = Schema.Struct({
  code: SymmetriaCommandRejectionCode,
  detail: Schema.NullOr(NonEmptyText),
});
export type SymmetriaCommandRejection = typeof SymmetriaCommandRejection.Type;

/**
 * A command that landed. `sequence` is the accepted position, which is all
 * `DispatchResult` ever returned; the fields around it are what it was missing.
 */
export const SymmetriaCommandAppliedReceipt = Schema.Struct({
  outcome: Schema.Literal("applied"),
  commandId: CommandId,
  threadId: ThreadId,
  application: SymmetriaCommandApplication,
  effect: SymmetriaCommandEffect,
  sequence: NonNegativeInteger,
});
export type SymmetriaCommandAppliedReceipt = typeof SymmetriaCommandAppliedReceipt.Type;

/**
 * A command that was refused. It carries no effect identity at all — not a
 * nulled one — because a refused command produced nothing, and a consumer that
 * reads an effect block on a refusal has been handed a shape it can misread.
 */
export const SymmetriaCommandRefusedReceipt = Schema.Struct({
  outcome: Schema.Literal("refused"),
  commandId: CommandId,
  threadId: ThreadId,
  application: SymmetriaCommandApplication,
  rejection: SymmetriaCommandRejection,
});
export type SymmetriaCommandRefusedReceipt = typeof SymmetriaCommandRefusedReceipt.Type;

/** What a caller is told about one `commandId`, however many times it asks. */
export const SymmetriaCommandReceipt = Schema.Union([
  SymmetriaCommandAppliedReceipt,
  SymmetriaCommandRefusedReceipt,
]);
export type SymmetriaCommandReceipt = typeof SymmetriaCommandReceipt.Type;

/**
 * The receipt a producer owes a caller that submits one `commandId` twice.
 *
 * Total, and it holds no clock and no store: it derives the second receipt from
 * the first by construction, which is the invariant written as code rather than
 * only asserted in a test. A producer that answers a duplicate with anything
 * else has broken the contract, whether or not this function was the thing that
 * built its answer.
 */
export const symmetriaReplayReceiptOf = (
  receipt: SymmetriaCommandReceipt,
): SymmetriaCommandReceipt => ({ ...receipt, application: "replay" });
