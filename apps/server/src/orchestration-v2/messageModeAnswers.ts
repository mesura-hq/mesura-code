import type { OrchestrationV2UserInputQuestion } from "@t3tools/contracts";

/**
 * Mesura: the reply line for one question a provider asked in message mode
 * (`responseCapability.type === "message"`), or `null` when the answer cannot
 * be sent. Fork commit 5c61984ca6 ("preserve question choices with notes"):
 *
 * - A part equal to one of the question's options (`value`, else `label`)
 *   is sent exactly, whitespace included: a choice must reach the provider as
 *   the exact value it offered. Other text is trimmed, as upstream does.
 * - A non-empty array of strings is a choice plus its note; the parts are
 *   sent on separate lines in one message.
 * - A question with `allowCustomAnswer: false` accepts only a string equal to
 *   one of its options (`value`, else `label`); a note cannot ride along.
 * - A blank answer is refused; the caller decides whether a question with
 *   `required: false` may be skipped instead.
 */
export function messageModeAnswerText(
  question: Pick<OrchestrationV2UserInputQuestion, "options" | "allowCustomAnswer">,
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
          value.every((entry): entry is string => typeof entry === "string")
        ? value
            .map(normalize)
            .filter((part) => part.trim().length > 0)
            .join("\n")
        : null;
  if (answer === null || answer.trim().length === 0) return null;
  if (question.allowCustomAnswer === false && (typeof value !== "string" || !isOption(value))) {
    return null;
  }
  return answer;
}
