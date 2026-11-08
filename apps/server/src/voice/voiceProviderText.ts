import type { OrchestrationMessageContext } from "@t3tools/contracts";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import { voiceAgentPrompt } from "@t3tools/shared/voice-conversation-prompts";

/**
 * Mesura: the text a provider receives for a user message. A spoken request carries its voice
 * context, which wraps the projected text in the voice agent instructions. Turn start and
 * steering both send user messages, so both use this one projection.
 */
export const projectUserMessageForProvider = (message: {
  readonly text: string;
  readonly context?: OrchestrationMessageContext | undefined;
}): string => {
  const projectedText = projectComposerContextForProvider({
    text: message.text,
    records: message.context?.records ?? [],
  });
  return message.context?.voice
    ? voiceAgentPrompt(projectedText, message.context.voice)
    : projectedText;
};

/** Spoken slash commands stay conversation data; only typed commands reach native shortcuts. */
export const isSpokenMessage = (message: {
  readonly context?: OrchestrationMessageContext | undefined;
}): boolean => message.context?.voice !== undefined;
