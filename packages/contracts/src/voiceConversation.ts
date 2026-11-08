import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, PositiveInt, ThreadId } from "./baseSchemas.ts";

export const VOICE_CONVERSATION_VOICES = [
  "marin",
  "cedar",
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "aube",
  "beacon",
  "bossa",
  "brise",
  "cinder",
  "delta",
  "flitz",
  "gleam",
  "harema",
  "juni",
  "meridian",
  "nira",
  "noeul",
  "nuri",
  "quartz",
  "ripple",
  "shitan",
  "sillage",
  "stone",
  "tempo",
  "vesper",
  "willow",
] as const;

export const VoiceConversationVoice = Schema.Literals(VOICE_CONVERSATION_VOICES);
export const VoiceConversationLanguage = Schema.Literals(["es", "en", "mixed"]);
export const VoiceConversationMode = Schema.Literals(["discuss", "research", "learn"]);
export type VoiceConversationMode = typeof VoiceConversationMode.Type;
export type VoiceConversationLanguage = typeof VoiceConversationLanguage.Type;
export type VoiceConversationVoice = typeof VoiceConversationVoice.Type;

export const VoiceConversationPreferences = Schema.Struct({
  handsFree: Schema.optionalKey(Schema.Boolean),
  learningSpace: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
});
export type VoiceConversationPreferences = typeof VoiceConversationPreferences.Type;

/** Provider-only context stays separate from the user's durable spoken message. */
export const VoiceAgentContext = Schema.Struct({
  promptEffort: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(128)))),
  mode: VoiceConversationMode,
  ...VoiceConversationPreferences.fields,
  transcript: Schema.Array(
    Schema.Struct({
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String.check(Schema.isMaxLength(12_000)),
    }),
  ).check(Schema.isMaxLength(8)),
});
export type VoiceAgentContext = typeof VoiceAgentContext.Type;

export const VoiceConversationSettings = Schema.Struct({
  configured: Schema.Boolean,
  canConfigure: Schema.Boolean,
  model: Schema.Literal("gpt-live-1"),
  maxDurationSeconds: Schema.Number,
});
export type VoiceConversationSettings = typeof VoiceConversationSettings.Type;

export const VoiceConversationConfigureInput = Schema.Struct({
  // An empty value removes the stored key. Keys are never returned to a client.
  apiKey: Schema.String.check(Schema.isMaxLength(512)),
});

export const VoiceConversationSessionId = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9_-]{16,80}$/),
);
export const VoiceConversationCreateInput = Schema.Struct({
  sessionId: VoiceConversationSessionId,
  threadId: ThreadId,
  sdp: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
  voice: VoiceConversationVoice,
  language: VoiceConversationLanguage,
  mode: VoiceConversationMode,
  ...VoiceConversationPreferences.fields,
});
export type VoiceConversationCreateInput = typeof VoiceConversationCreateInput.Type;
export const VoiceConversationCreateResult = Schema.Struct({
  sessionId: VoiceConversationSessionId,
  sdp: Schema.String,
});
export const VoiceConversationSessionInput = Schema.Struct({
  sessionId: VoiceConversationSessionId,
});
export const VoiceConversationEndInput = Schema.Struct({
  sessionId: VoiceConversationSessionId,
  // The owner's final transcript sequence. Fragments up to it stay accepted after the hangup.
  lastSequence: Schema.optionalKey(NonNegativeInt),
});
export const VoiceConversationAcknowledgement = Schema.Struct({ ok: Schema.Boolean });

// ── Persisted voice history ──────────────────────────────────────────
// A call's history is a projection of three thread events in the orchestration event store.
// Only spoken input and output transcripts are stored: never prompts, thinking, tool work,
// audio, or the agent's written replies.

export const VOICE_HISTORY_MAX_PAGE_SIZE = 200;
export const VOICE_HISTORY_DEFAULT_PAGE_SIZE = 100;
export const VOICE_TRANSCRIPT_MAX_BATCH_FRAGMENTS = 100;

/** A call is identified by the client session ID it was created with. It is not a credential. */
export const VoiceCallId = VoiceConversationSessionId;
export const VoiceHistoryItemId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/));
export const VoiceTranscriptSpeaker = Schema.Literals(["user", "assistant"]);
export type VoiceTranscriptSpeaker = typeof VoiceTranscriptSpeaker.Type;

/** One spoken transcript segment, with its text exactly as the provider transcribed it. */
export const VoiceTranscriptFragment = Schema.Struct({
  fragmentId: VoiceHistoryItemId,
  sequence: PositiveInt,
  speaker: VoiceTranscriptSpeaker,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(12_000)),
  startOffsetMs: Schema.optionalKey(NonNegativeInt),
  endOffsetMs: Schema.optionalKey(NonNegativeInt),
});
export type VoiceTranscriptFragment = typeof VoiceTranscriptFragment.Type;

/**
 * `hangup` is the owner's explicit end. The server ends a call as `interrupted` after a restart,
 * `expired` when the owner's heartbeat lease lapses, and `max-duration` at the 15-minute limit.
 */
export const VoiceCallEndReason = Schema.Literals([
  "hangup",
  "interrupted",
  "expired",
  "max-duration",
]);
export type VoiceCallEndReason = typeof VoiceCallEndReason.Type;

const VoiceTranscriptFragments = Schema.Array(VoiceTranscriptFragment).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(VOICE_TRANSCRIPT_MAX_BATCH_FRAGMENTS),
);

/** Voice history events never change messages, work, turns, or the sidebar summary. */
export const VOICE_HISTORY_EVENT_TYPES = [
  "thread.voice-call-started",
  "thread.voice-transcript-appended",
  "thread.voice-call-ended",
] as const;
export type VoiceHistoryEventType = (typeof VOICE_HISTORY_EVENT_TYPES)[number];
const voiceHistoryEventTypes: ReadonlySet<string> = new Set(VOICE_HISTORY_EVENT_TYPES);
export const isVoiceHistoryEventType = (type: string): type is VoiceHistoryEventType =>
  voiceHistoryEventTypes.has(type);

export const VoiceCallStartedPayload = Schema.Struct({
  threadId: ThreadId,
  callId: VoiceCallId,
  /** A one-way digest of the owning client identity, never the credential itself. */
  ownerKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  startedAt: IsoDateTime,
});
export type VoiceCallStartedPayload = typeof VoiceCallStartedPayload.Type;

export const VoiceTranscriptAppendedPayload = Schema.Struct({
  threadId: ThreadId,
  callId: VoiceCallId,
  batchId: VoiceHistoryItemId,
  /**
   * The complete accepted batch, as sent. It may repeat fragments the call already holds; those
   * keep their first content, so a fragment is never stored twice.
   */
  fragments: VoiceTranscriptFragments,
  appendedAt: IsoDateTime,
});
export type VoiceTranscriptAppendedPayload = typeof VoiceTranscriptAppendedPayload.Type;

/**
 * `lastSequence` is the owner's final transcript boundary, or null when the server ended the
 * call without one. A later ended event for an already ended call only records the owner's
 * missing boundary: the first reason and end time stay.
 */
export const VoiceCallEndedPayload = Schema.Struct({
  threadId: ThreadId,
  callId: VoiceCallId,
  reason: VoiceCallEndReason,
  lastSequence: Schema.NullOr(NonNegativeInt),
  endedAt: IsoDateTime,
});
export type VoiceCallEndedPayload = typeof VoiceCallEndedPayload.Type;

export const VoiceTranscriptAppendInput = Schema.Struct({
  sessionId: VoiceConversationSessionId,
  batchId: VoiceHistoryItemId,
  fragments: VoiceTranscriptFragments,
});
export type VoiceTranscriptAppendInput = typeof VoiceTranscriptAppendInput.Type;
export const VoiceTranscriptAppendResult = Schema.Struct({
  /** The highest stored fragment sequence of the call. */
  lastSequence: NonNegativeInt,
});

export const VoiceCallSummary = Schema.Struct({
  callId: VoiceCallId,
  threadId: ThreadId,
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  endReason: Schema.NullOr(VoiceCallEndReason),
  /** The owner's final boundary; null while the call is open or the owner has not declared it. */
  finalSequence: Schema.NullOr(NonNegativeInt),
  lastSequence: NonNegativeInt,
  ownedByRequester: Schema.Boolean,
});
export type VoiceCallSummary = typeof VoiceCallSummary.Type;

export const VoiceCallPage = Schema.Struct({
  calls: Schema.Array(VoiceCallSummary),
  nextCursor: Schema.NullOr(Schema.String),
});
export type VoiceCallPage = typeof VoiceCallPage.Type;

export const VoiceTranscriptPage = Schema.Struct({
  call: VoiceCallSummary,
  fragments: Schema.Array(VoiceTranscriptFragment),
  nextAfterSequence: Schema.NullOr(NonNegativeInt),
});
export type VoiceTranscriptPage = typeof VoiceTranscriptPage.Type;

// GET query values arrive as strings. A limit above the maximum is a 400.
const VoiceHistoryPageLimit = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(VOICE_HISTORY_MAX_PAGE_SIZE),
);
export const VoiceCallListParams = Schema.Struct({ threadId: ThreadId });
export const VoiceCallListQuery = {
  limit: Schema.optional(VoiceHistoryPageLimit),
  cursor: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))),
};
export const VoiceTranscriptListParams = Schema.Struct({ threadId: ThreadId, callId: VoiceCallId });
export const VoiceTranscriptListQuery = {
  limit: Schema.optional(VoiceHistoryPageLimit),
  afterSequence: Schema.optional(
    Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
};

export class VoiceConversationError extends Schema.TaggedError<VoiceConversationError>()(
  "VoiceConversationError",
  { message: Schema.String, status: Schema.Literals([400, 404, 409, 502, 503, 504]) },
  { httpApiStatus: 400 },
) {}

const voiceErrorAtStatus = (status: VoiceConversationError["status"]) =>
  VoiceConversationError.check(Schema.makeFilter((error) => error.status === status)).annotate({
    httpApiStatus: status,
  });

export const VoiceConversationHttpErrors = [
  voiceErrorAtStatus(400),
  voiceErrorAtStatus(404),
  voiceErrorAtStatus(409),
  voiceErrorAtStatus(502),
  voiceErrorAtStatus(503),
  voiceErrorAtStatus(504),
] as const;
