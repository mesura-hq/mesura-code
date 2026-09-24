import type { UserInputQuestion } from "@t3tools/contracts";

export interface PendingUserInputDraftAnswer {
  selectedOptionValues?: ReadonlyArray<string>;
  customAnswer?: string;
  attachmentCount?: number;
  attachmentsBlocked?: boolean;
}

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeSelectedOptionValues(value: ReadonlyArray<string> | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  // Provider option IDs must stay unchanged, including whitespace.
  return Array.from(new Set(value.filter((entry) => typeof entry === "string")));
}

function resolveOptionValue(question: UserInputQuestion, value: string): string | undefined {
  const exact = question.options.find((option) => (option.value ?? option.label) === value);
  if (exact) return exact.value ?? exact.label;
  // Legacy clients padded labels. Recover the provider's original label, never an opaque ID.
  if (question.allowCustomAnswer === false) return undefined;
  return question.options.find(
    (option) => option.value === undefined && option.label.trim() === value.trim(),
  )?.label;
}

function selectedValues(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): string[] {
  return Array.from(
    new Set(
      normalizeSelectedOptionValues(draft?.selectedOptionValues)
        .map((value) => resolveOptionValue(question, value))
        .filter((value): value is string => value !== undefined),
    ),
  );
}

export function resolvePendingUserInputAnswer(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): string | string[] | null {
  if (draft?.attachmentsBlocked) return null;
  const customAnswer =
    question.allowCustomAnswer === false ? null : normalizeDraftAnswer(draft?.customAnswer);
  const selectedOptionValues = selectedValues(question, draft);
  const choices = question.multiSelect ? selectedOptionValues : selectedOptionValues.slice(0, 1);
  if (choices.length > 0) {
    if (customAnswer) return [...choices, customAnswer];
    return question.multiSelect ? choices : choices[0]!;
  }
  return (
    customAnswer ??
    (question.allowCustomAnswer !== false && (draft?.attachmentCount ?? 0) > 0 ? "" : null)
  );
}

export function setPendingUserInputCustomAnswer(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
): PendingUserInputDraftAnswer {
  if (question.allowCustomAnswer === false) return draft ?? {};
  return { ...draft, customAnswer };
}

export function isPendingUserInputOptionSelected(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionValue: string,
): boolean {
  const value = resolveOptionValue(question, optionValue);
  return value !== undefined && selectedValues(question, draft).includes(value);
}

export function togglePendingUserInputOptionSelection(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionValue: string,
): PendingUserInputDraftAnswer {
  const value = resolveOptionValue(question, optionValue);
  if (value === undefined) {
    return draft ?? {};
  }
  const selected = selectedValues(question, draft);
  const nextSelected = question.multiSelect
    ? selected.includes(value)
      ? selected.filter((selectedValue) => selectedValue !== value)
      : [...selected, value]
    : [value];
  const { selectedOptionValues: _previous, ...rest } = draft ?? {};
  return {
    customAnswer: "",
    ...rest,
    ...(nextSelected.length > 0 ? { selectedOptionValues: nextSelected } : {}),
  };
}

export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, string | string[]> | null {
  const answers: Record<string, string | string[]> = {};

  for (const question of questions) {
    const answer = resolvePendingUserInputAnswer(question, draftAnswers[question.id]);
    if (answer === null) {
      return null;
    }
    answers[question.id] = answer;
  }

  return answers;
}
