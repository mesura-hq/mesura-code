import type { OrchestrationV2UserInputQuestion } from "@t3tools/contracts";

/**
 * Mesura: the reply line for a message-mode question, or `null` when it cannot be sent. An option
 * (`value`, else `label`) is sent exactly, whitespace included; other text is trimmed. A string
 * array joins multiple choices with commas, or a choice and its note with separate lines. `allowCustomAnswer: false` accepts only a single
 * option string, and a blank answer is refused (the caller decides whether to skip instead).
 */
export function messageModeAnswerText(
  question: Pick<OrchestrationV2UserInputQuestion, "options" | "allowCustomAnswer" | "multiSelect">,
  value: unknown,
): string | null {
  const isOption = (text: string) =>
    question.options.some((option) => (option.value ?? option.label) === text);
  const normalize = (text: string) => (isOption(text) ? text : text.trim());
  const answer =
    typeof value === "string"
      ? normalize(value)
      : Array.isArray(value) &&
          value.length > 0 &&
          value.every(
            (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
          )
        ? value.map(normalize).join(question.multiSelect ? ", " : "\n")
        : null;
  if (answer === null || answer.trim().length === 0) return null;
  if (question.allowCustomAnswer === false && (typeof value !== "string" || !isOption(value))) {
    return null;
  }
  return answer;
}
