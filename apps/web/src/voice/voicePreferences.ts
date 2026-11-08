import type {
  ClientSettings,
  EnvironmentId,
  ProjectId,
  VoiceConversationLanguage,
  VoiceConversationMode,
  VoiceConversationVoice,
} from "@t3tools/contracts";

type VoicePreferences = ClientSettings["voiceConversation"];

/** The repository a learning space belongs to. */
export interface VoiceLearningScope {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

/** What one call uses. A call resolves this once, when it starts. */
export interface VoiceCallPreferences {
  readonly voice: VoiceConversationVoice;
  readonly language: VoiceConversationLanguage;
  readonly mode: VoiceConversationMode;
  readonly handsFree: boolean;
  readonly learningSpace: string;
}

const learningSpaceKey = (scope: VoiceLearningScope) => `${scope.environmentId}:${scope.projectId}`;

export function resolveVoiceCallPreferences(
  preferences: VoicePreferences,
  scope: VoiceLearningScope,
): VoiceCallPreferences {
  return {
    voice: preferences.voice,
    language: preferences.language,
    mode: preferences.mode,
    handsFree: preferences.handsFree,
    learningSpace: preferences.learningSpaces[learningSpaceKey(scope)] ?? "",
  };
}

/** The preferences with this repository's learning space set, or removed when blank. */
export function withVoiceLearningSpace(
  preferences: VoicePreferences,
  scope: VoiceLearningScope,
  learningSpace: string,
): VoicePreferences {
  const { [learningSpaceKey(scope)]: _previous, ...others } = preferences.learningSpaces;
  const trimmed = learningSpace.trim();
  return {
    ...preferences,
    learningSpaces: trimmed ? { ...others, [learningSpaceKey(scope)]: trimmed } : others,
  };
}
