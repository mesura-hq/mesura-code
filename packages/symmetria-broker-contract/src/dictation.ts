/**
 * One Shell-owned dictation session as Mesura and Symmetria Shell exchange it.
 *
 * Audio, provider configuration, transcript history and recovery never cross
 * this contract. The final dictated text appears only on `dictation.deliver`;
 * every snapshot and presentation update stays safe to render in the Shell.
 *
 * A target is captured before recording and is immutable for the session. A
 * process id, window address and current route can discover the Mesura surface,
 * but none of them can address the text after an asynchronous transcription.
 */
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { NonEmptyText, NonNegativeInteger, SymmetriaDraftVersion } from "./primitives.ts";
import { SymmetriaProtocolVersion } from "./version.ts";

export const SymmetriaDictationSessionId = NonEmptyText.pipe(
  Schema.brand("SymmetriaDictationSessionId"),
);
export type SymmetriaDictationSessionId = typeof SymmetriaDictationSessionId.Type;

/** The client-local key of a composer draft that has not reached the server. */
export const SymmetriaComposerDraftId = NonEmptyText.pipe(Schema.brand("SymmetriaComposerDraftId"));
export type SymmetriaComposerDraftId = typeof SymmetriaComposerDraftId.Type;

export const SymmetriaScopedThreadRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
}).annotate({ identifier: "SymmetriaScopedThreadRef" });
export type SymmetriaScopedThreadRef = typeof SymmetriaScopedThreadRef.Type;

export const SymmetriaDictationThreadTarget = Schema.Struct({
  kind: Schema.Literal("thread"),
  environmentId: EnvironmentId,
  threadId: ThreadId,
}).annotate({ identifier: "SymmetriaDictationThreadTarget" });
export type SymmetriaDictationThreadTarget = typeof SymmetriaDictationThreadTarget.Type;

/**
 * A new chat has both identities before its first send. `draftId` addresses
 * the local composer; `futureThreadRef` is the exact server thread its first
 * send will create. Carrying both lets a reservation survive promotion without
 * consulting the route that happens to be visible later.
 */
export const SymmetriaDictationDraftTarget = Schema.Struct({
  kind: Schema.Literal("draft"),
  draftId: SymmetriaComposerDraftId,
  futureThreadRef: SymmetriaScopedThreadRef,
}).annotate({ identifier: "SymmetriaDictationDraftTarget" });
export type SymmetriaDictationDraftTarget = typeof SymmetriaDictationDraftTarget.Type;

export const SymmetriaDictationTarget = Schema.Union([
  SymmetriaDictationThreadTarget,
  SymmetriaDictationDraftTarget,
]);
export type SymmetriaDictationTarget = typeof SymmetriaDictationTarget.Type;

export const SYMMETRIA_DICTATION_PHASES = [
  "recording",
  "paused",
  "processing",
  "grace",
  "delivering",
  "confirming",
  "completed",
  "failed",
  "cancelled",
] as const;
export const SymmetriaDictationPhase = Schema.Literals(SYMMETRIA_DICTATION_PHASES);
export type SymmetriaDictationPhase = typeof SymmetriaDictationPhase.Type;

export const SYMMETRIA_DICTATION_MODES = ["clipboard", "inject", "submit"] as const;
export const SymmetriaDictationMode = Schema.Literals(SYMMETRIA_DICTATION_MODES);
export type SymmetriaDictationMode = typeof SymmetriaDictationMode.Type;

export const SYMMETRIA_DICTATION_SOURCES = ["shell", "mesura"] as const;
export const SymmetriaDictationSource = Schema.Literals(SYMMETRIA_DICTATION_SOURCES);
export type SymmetriaDictationSource = typeof SymmetriaDictationSource.Type;

export const SYMMETRIA_DICTATION_CONTROL_ACTIONS = [
  "start",
  "pause",
  "resume",
  "cancel",
  "restart",
  "stop",
  "retry",
  "send-now",
] as const;
export const SymmetriaDictationControlAction = Schema.Literals(SYMMETRIA_DICTATION_CONTROL_ACTIONS);

const AudioLevel = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

export const SymmetriaDictationPresentation = Schema.Struct({
  mesuraOwnsPresentation: Schema.Boolean,
  leaseExpiresAt: Schema.NullOr(IsoDateTime),
}).annotate({ identifier: "SymmetriaDictationPresentation" });
export type SymmetriaDictationPresentation = typeof SymmetriaDictationPresentation.Type;

/** The complete non-transcript snapshot sent first on every session connection. */
export const SymmetriaDictationSession = Schema.Struct({
  protocolVersion: SymmetriaProtocolVersion,
  sessionId: SymmetriaDictationSessionId,
  target: SymmetriaDictationTarget,
  source: SymmetriaDictationSource,
  phase: SymmetriaDictationPhase,
  mode: SymmetriaDictationMode,
  projectName: Schema.NullOr(NonEmptyText),
  startedAt: IsoDateTime,
  elapsedMs: NonNegativeInteger,
  audioLevel: Schema.NullOr(AudioLevel),
  graceRemainingMs: Schema.NullOr(NonNegativeInteger),
  lastControl: Schema.optionalKey(
    Schema.Struct({
      commandId: CommandId,
      action: SymmetriaDictationControlAction,
    }),
  ),
  lastVocabulary: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ commandId: CommandId, action: Schema.Literal("add"), word: NonEmptyText }),
      Schema.Struct({
        commandId: CommandId,
        action: Schema.Literal("remove"),
        index: NonNegativeInteger,
      }),
      Schema.Struct({ commandId: CommandId, action: Schema.Literal("toggle") }),
    ]),
  ),
  presentation: SymmetriaDictationPresentation,
}).annotate({ identifier: "SymmetriaDictationSession" });
export type SymmetriaDictationSession = typeof SymmetriaDictationSession.Type;

const DictationCommandBaseFields = {
  protocolVersion: SymmetriaProtocolVersion,
  sessionId: SymmetriaDictationSessionId,
  commandId: CommandId,
  createdAt: IsoDateTime,
} as const;

/** Starts one Shell job after the renderer reserves the supplied target. */
export const SymmetriaDictationReserveCommand = Schema.Struct({
  type: Schema.Literal("dictation.reserve"),
  ...DictationCommandBaseFields,
  source: SymmetriaDictationSource,
  target: SymmetriaDictationTarget,
}).annotate({ identifier: "SymmetriaDictationReserveCommand" });

export const SymmetriaDictationControlCommand = Schema.Struct({
  type: Schema.Literal("dictation.control"),
  ...DictationCommandBaseFields,
  action: SymmetriaDictationControlAction,
}).annotate({ identifier: "SymmetriaDictationControlCommand" });

export const SymmetriaDictationModeCommand = Schema.Struct({
  type: Schema.Literal("dictation.mode.set"),
  ...DictationCommandBaseFields,
  mode: SymmetriaDictationMode,
}).annotate({ identifier: "SymmetriaDictationModeCommand" });

/** Publishes engine-owned progress without changing the reserved target or mode. */
export const SymmetriaDictationStateUpdateCommand = Schema.Struct({
  type: Schema.Literal("dictation.state.update"),
  ...DictationCommandBaseFields,
  phase: SymmetriaDictationPhase,
  elapsedMs: NonNegativeInteger,
  audioLevel: Schema.NullOr(AudioLevel),
  graceRemainingMs: Schema.NullOr(NonNegativeInteger),
}).annotate({ identifier: "SymmetriaDictationStateUpdateCommand" });

export const SymmetriaDictationVocabularyCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("dictation.vocabulary.add"),
    ...DictationCommandBaseFields,
    word: NonEmptyText,
  }),
  Schema.Struct({
    type: Schema.Literal("dictation.vocabulary.remove"),
    ...DictationCommandBaseFields,
    index: NonNegativeInteger,
  }),
  Schema.Struct({
    type: Schema.Literal("dictation.vocabulary.toggle"),
    ...DictationCommandBaseFields,
  }),
]).annotate({ identifier: "SymmetriaDictationVocabularyCommand" });

export const SymmetriaDictationActionAcknowledgementCommand = Schema.Struct({
  type: Schema.Literal("dictation.action.acknowledge"),
  ...DictationCommandBaseFields,
  actionKind: Schema.Literals(["control", "vocabulary"]),
  acknowledgedCommandId: CommandId,
}).annotate({ identifier: "SymmetriaDictationActionAcknowledgementCommand" });

/** The only command whose body carries the dictated words. */
export const SymmetriaDictationDeliverCommand = Schema.Struct({
  type: Schema.Literal("dictation.deliver"),
  ...DictationCommandBaseFields,
  target: SymmetriaDictationTarget,
  mode: SymmetriaDictationMode,
  text: NonEmptyText,
}).annotate({ identifier: "SymmetriaDictationDeliverCommand" });

export const SymmetriaDictationPresentationCommand = Schema.Struct({
  type: Schema.Literal("dictation.presentation"),
  ...DictationCommandBaseFields,
  target: SymmetriaDictationTarget,
  focused: Schema.Boolean,
  visible: Schema.Boolean,
  displayedTarget: Schema.Boolean,
  leaseExpiresAt: IsoDateTime,
}).annotate({ identifier: "SymmetriaDictationPresentationCommand" });

export const SymmetriaDictationCommand = Schema.Union([
  SymmetriaDictationReserveCommand,
  SymmetriaDictationControlCommand,
  SymmetriaDictationModeCommand,
  SymmetriaDictationStateUpdateCommand,
  SymmetriaDictationVocabularyCommand,
  SymmetriaDictationActionAcknowledgementCommand,
  SymmetriaDictationDeliverCommand,
  SymmetriaDictationPresentationCommand,
]);
export type SymmetriaDictationCommand = typeof SymmetriaDictationCommand.Type;

export const SYMMETRIA_DICTATION_RECEIPT_OUTCOMES = [
  "copied",
  "inserted",
  "turn-running",
  "confirmation-pending",
  "refused",
  "failed",
] as const;

export const SYMMETRIA_DICTATION_APPLICATIONS = ["first", "replay"] as const;
export const SymmetriaDictationApplication = Schema.Literals(SYMMETRIA_DICTATION_APPLICATIONS);

const DictationReceiptBaseFields = {
  protocolVersion: SymmetriaProtocolVersion,
  sessionId: SymmetriaDictationSessionId,
  commandId: CommandId,
  target: SymmetriaDictationTarget,
  application: SymmetriaDictationApplication,
} as const;

export const SymmetriaDictationCopiedReceipt = Schema.Struct({
  outcome: Schema.Literal("copied"),
  ...DictationReceiptBaseFields,
}).annotate({ identifier: "SymmetriaDictationCopiedReceipt" });

export const SymmetriaDictationInsertedReceipt = Schema.Struct({
  outcome: Schema.Literal("inserted"),
  ...DictationReceiptBaseFields,
  draftVersion: SymmetriaDraftVersion,
  action: Schema.optionalKey(Schema.Literals(["insert", "answer", "submit"])),
}).annotate({ identifier: "SymmetriaDictationInsertedReceipt" });

export const SymmetriaDictationTurnRunningReceipt = Schema.Struct({
  outcome: Schema.Literal("turn-running"),
  ...DictationReceiptBaseFields,
  messageId: MessageId,
  turnId: TurnId,
}).annotate({ identifier: "SymmetriaDictationTurnRunningReceipt" });

export const SymmetriaDictationConfirmationPendingReceipt = Schema.Struct({
  outcome: Schema.Literal("confirmation-pending"),
  ...DictationReceiptBaseFields,
}).annotate({ identifier: "SymmetriaDictationConfirmationPendingReceipt" });

export const SYMMETRIA_DICTATION_REFUSAL_CODES = [
  "shell_unavailable",
  "target_missing",
  "unsupported_composer_action",
  "unsupported_protocol",
] as const;
export const SymmetriaDictationRefusalCode = Schema.Literals(SYMMETRIA_DICTATION_REFUSAL_CODES);

export const SYMMETRIA_DICTATION_FAILURE_CODES = [
  "renderer_lost",
  "provider_start_failed",
  "provider_turn_failed",
  "persistence_failed",
  "deadline_exceeded",
  "malformed_input",
] as const;
export const SymmetriaDictationFailureCode = Schema.Literals(SYMMETRIA_DICTATION_FAILURE_CODES);

export const SymmetriaDictationRefusedReceipt = Schema.Struct({
  outcome: Schema.Literal("refused"),
  ...DictationReceiptBaseFields,
  code: SymmetriaDictationRefusalCode,
  detail: Schema.NullOr(NonEmptyText),
}).annotate({ identifier: "SymmetriaDictationRefusedReceipt" });

export const SymmetriaDictationFailedReceipt = Schema.Struct({
  outcome: Schema.Literal("failed"),
  ...DictationReceiptBaseFields,
  code: SymmetriaDictationFailureCode,
  detail: Schema.NullOr(NonEmptyText),
}).annotate({ identifier: "SymmetriaDictationFailedReceipt" });

export const SymmetriaDictationReceipt = Schema.Union([
  SymmetriaDictationCopiedReceipt,
  SymmetriaDictationInsertedReceipt,
  SymmetriaDictationTurnRunningReceipt,
  SymmetriaDictationConfirmationPendingReceipt,
  SymmetriaDictationRefusedReceipt,
  SymmetriaDictationFailedReceipt,
]);
export type SymmetriaDictationReceipt = typeof SymmetriaDictationReceipt.Type;
