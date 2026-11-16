import type { OrchestrationV2UserInputQuestion } from "@t3tools/contracts";

/**
 * Mesura: the reply line for a message-mode question, or `null` when it cannot be sent. Options are
 * sent exactly, other text trimmed; arrays join choices with commas or a choice and note by line.
 * `allowCustomAnswer: false` accepts only exact options (several when `multiSelect`).
 */
export function messageModeAnswerText(
  question: Pick<OrchestrationV2UserInputQuestion, "options" | "allowCustomAnswer" | "multiSelect">,
  value: unknown,
): string | null {
  const isOption = (text: string) =>
    question.options.some((option) => (option.value ?? option.label) === text);
  const normalize = (text: string) => (isOption(text) ? text : text.trim());
  const isChoiceOnlyAnswer = (candidate: unknown) =>
    typeof candidate === "string"
      ? isOption(candidate)
      : question.multiSelect === true &&
        Array.isArray(candidate) &&
        candidate.every((entry) => typeof entry === "string" && isOption(entry));
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
  if (question.allowCustomAnswer === false && !isChoiceOnlyAnswer(value)) return null;
  return answer;
}
