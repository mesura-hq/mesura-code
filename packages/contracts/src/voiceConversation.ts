import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

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
export const VoiceConversationAcknowledgement = Schema.Struct({ ok: Schema.Boolean });

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
