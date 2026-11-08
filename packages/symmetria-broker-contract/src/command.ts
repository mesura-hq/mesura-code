/**
 * What a surface outside this fork may ask of one thread. Nothing here enforces the semantics at
 * runtime: a producer owes the receipt's guarantee (one `commandId`, one effect, an identical second
 * receipt). The key is upstream's `CommandId`, which is also the correlation id, because upstream's
 * `DispatchResult` is only `{ sequence }` and cannot tell a replay from a fresh command.
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
 * Shared by every command so none grows its own address spelling. `threadId` is the whole target: a
 * reused pane slot or window handle delivers a dictation to the wrong thread. No `EnvironmentId`: this
 * projection is one environment's, like the thread summary and the stream snapshot.
 */
const CommandBaseFields = {
  commandId: CommandId,
  threadId: ThreadId,
  protocolVersion: SymmetriaProtocolVersion,
  createdAt: IsoDateTime,
} as const;

/**
 * No attachments (upstream admits a 10 MB image a polling shell cannot carry) and no model selection
 * (the thread's own applies). `text` is `NonEmptyText`, Symmetria's own rule since upstream turn text
 * is a bare string; it must survive into the emitted JSON Schema, or a shell validates a whitespace-only
 * dictation the broker then refuses.
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
 * `expectedVersion` is required: a draft set that cannot state its expectation is the silent
 * overwrite the contract refuses. Phase four should make `SymmetriaDraftUpdate` this body, not a
 * second struct that states the rule again. `text` may be empty: clearing the composer is a draft.
 */
export const SymmetriaDraftSetCommand = Schema.Struct({
  type: Schema.Literal("thread.draft.set"),
  ...CommandBaseFields,
  text: Schema.String,
  expectedVersion: SymmetriaDraftVersion,
});
export type SymmetriaDraftSetCommand = typeof SymmetriaDraftSetCommand.Type;

/**
 * Addresses a thread, never a window; `targetSurfaceId` (a `ClientActivityClientId`, as presence
 * publishes) optionally names the surface, else the resolver picks and the receipt reports it. The
 * single effect: the thread becomes selected and the surface is revealed once. A replay of the same
 * `commandId` re-reports that outcome, never a second reveal.
 */
export const SymmetriaActivateCommand = Schema.Struct({
  type: Schema.Literal("thread.activate"),
  ...CommandBaseFields,
  targetSurfaceId: Schema.optionalKey(ClientActivityClientId),
});
export type SymmetriaActivateCommand = typeof SymmetriaActivateCommand.Type;

/**
 * Four tags, deliberately, against upstream's 23 dispatchable client commands: this is a shell-facing
 * contract, not a mirror of the app. Widening later is additive; narrowing after a consumer ships is
 * not. Upstream's two tags keep their spelling; Symmetria's two follow the same dotted style.
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
 * The only field on which two receipts for one `commandId` may differ. Everything else is what the
 * first application decided, and a replay restates it.
 */
export const SymmetriaCommandApplication = Schema.Literals(["first", "replay"]);
export type SymmetriaCommandApplication = typeof SymmetriaCommandApplication.Type;

/**
 * Flat, not a union by command: the module's guarantee is one deep equality between two receipts, so
 * every command reports every slot and leaves unfilled ones null. An interrupt fills `turnId` with
 * the turn it stopped; an activation fills `activatedSurfaceId` with the surface that revealed.
 */
export const SymmetriaCommandEffect = Schema.Struct({
  turnId: Schema.NullOr(TurnId),
  draftVersion: Schema.NullOr(SymmetriaDraftVersion),
  activatedSurfaceId: Schema.NullOr(ClientActivityClientId),
});
export type SymmetriaCommandEffect = typeof SymmetriaCommandEffect.Type;

/**
 * A closed vocabulary to branch on, in the fork's `ProjectEntriesFailure` idiom; nothing may branch on
 * `detail`. `detail` is nullable, not optional, so a consumer reads one shape, and `NonEmptyText`
 * refuses an empty sentence for consumers that are not TypeScript.
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
 * Total, with no clock and no store: derives the second receipt from the first by construction. A
 * producer that answers a duplicate `commandId` with anything else breaks the contract.
 */
export const symmetriaReplayReceiptOf = (
  receipt: SymmetriaCommandReceipt,
): SymmetriaCommandReceipt => ({ ...receipt, application: "replay" });
