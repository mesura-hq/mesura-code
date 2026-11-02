import type { OrchestrationV2UserInputQuestion } from "@t3tools/contracts";

/**
 * Mesura: a message-mode reply line, or `null`. Options go exactly; other text is trimmed. An array
 * is a choice plus its note, one per line; on `multiSelect`, upstream's picks, comma-separated.
 * `allowCustomAnswer: false` takes only options. A blank answer is refused; the caller may skip.
 */
export function messageModeAnswerText(
  question: Pick<OrchestrationV2UserInputQuestion, "options" | "allowCustomAnswer" | "multiSelect">,
  value: unknown,
): string | null {
  const isOption = (text: string) =>
    question.options.some((option) => (option.value ?? option.label) === text);
  const normalize = (text: string) => (isOption(text) ? text : text.trim());
  const strings =
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry): entry is string => typeof entry === "string")
      ? value
      : null;
  if (question.multiSelect === true && strings !== null) {
    const picks = strings.map(normalize);
    const valid = picks.every(
      (pick) => pick.trim().length > 0 && (question.allowCustomAnswer !== false || isOption(pick)),
    );
    return valid ? picks.join(", ") : null;
  }
  const answer =
    typeof value === "string"
      ? normalize(value)
      : strings === null
        ? null
        : strings
            .map(normalize)
            .filter((part) => part.trim().length > 0)
            .join("\n");
  if (answer === null || answer.trim().length === 0) return null;
  if (question.allowCustomAnswer === false && (typeof value !== "string" || !isOption(value))) {
    return null;
  }
  return answer;
}
