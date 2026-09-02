import type { UserInputQuestion } from "@t3tools/contracts";

export interface PendingUserInputDraftAnswer {
  selectedOptionLabels?: string[];
  customAnswer?: string;
}

export interface PendingUserInputProgress {
  questionIndex: number;
  activeQuestion: UserInputQuestion | null;
  activeDraft: PendingUserInputDraftAnswer | undefined;
  selectedOptionLabels: string[];
  customAnswer: string;
  resolvedAnswer: string | string[] | null;
  usingCustomAnswer: boolean;
  answeredQuestionCount: number;
  isLastQuestion: boolean;
  isComplete: boolean;
  canAdvance: boolean;
  /**
   * The first question still missing an answer, or null when every one of them
   * has one. The submit control reads it to say WHICH answer is missing: the
   * prompt shows one question at a time, so a set that cannot be submitted
   * gives the user nothing to look at without it.
   */
  firstUnansweredQuestionIndex: number | null;
}

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSelectedOptionLabels(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length > 0) {
      normalized.push(trimmed);
    }
  }

  return Array.from(new Set(normalized));
}

export function resolvePendingUserInputAnswer(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): string | string[] | null {
  const customAnswer = normalizeDraftAnswer(draft?.customAnswer);
  if (customAnswer) {
    return customAnswer;
  }

  const selectedOptionLabels = normalizeSelectedOptionLabels(draft?.selectedOptionLabels);
  if (question.multiSelect) {
    return selectedOptionLabels.length > 0 ? selectedOptionLabels : null;
  }

  return selectedOptionLabels[0] ?? null;
}

export function setPendingUserInputCustomAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
): PendingUserInputDraftAnswer {
  const selectedOptionLabels =
    customAnswer.trim().length > 0
      ? undefined
      : normalizeSelectedOptionLabels(draft?.selectedOptionLabels);

  return {
    customAnswer,
    ...(selectedOptionLabels && selectedOptionLabels.length > 0 ? { selectedOptionLabels } : {}),
  };
}

export function togglePendingUserInputOptionSelection(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionLabel: string,
): PendingUserInputDraftAnswer {
  if (question.multiSelect) {
    const selectedOptionLabels = normalizeSelectedOptionLabels(draft?.selectedOptionLabels);
    const nextSelectedOptionLabels = selectedOptionLabels.includes(optionLabel)
      ? selectedOptionLabels.filter((label) => label !== optionLabel)
      : [...selectedOptionLabels, optionLabel];

    return {
      customAnswer: "",
      ...(nextSelectedOptionLabels.length > 0
        ? { selectedOptionLabels: nextSelectedOptionLabels }
        : {}),
    };
  }

  return {
    customAnswer: "",
    selectedOptionLabels: [optionLabel],
  };
}

export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, string | string[]> | null {
  const answers: Record<string, string | string[]> = {};

  for (const question of questions) {
    const answer = resolvePendingUserInputAnswer(question, draftAnswers[question.id]);
    if (!answer) {
      return null;
    }
    answers[question.id] = answer;
  }

  return answers;
}

export function findFirstUnansweredPendingUserInputQuestionIndex(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  const unansweredIndex = questions.findIndex(
    (question) => !resolvePendingUserInputAnswer(question, draftAnswers[question.id]),
  );

  return unansweredIndex === -1 ? Math.max(questions.length - 1, 0) : unansweredIndex;
}

export function countAnsweredPendingUserInputQuestions(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  return questions.reduce((count, question) => {
    return resolvePendingUserInputAnswer(question, draftAnswers[question.id]) ? count + 1 : count;
  }, 0);
}

/**
 * Whether `key` is the digit shortcut of one of this question's options.
 *
 * Two listeners have to agree on this and they are not in the same file: the
 * panel acts on the digit, and the window-level type-to-focus handler has to
 * let it through. That handler runs in the capture phase, so a disagreement
 * does not degrade gracefully — it swallows the key and types it into the
 * custom answer, which clears the option the user had already picked.
 */
export function isPendingUserInputOptionShortcut(
  question: UserInputQuestion | null,
  key: string,
): boolean {
  if (!question) {
    return false;
  }
  const digit = Number.parseInt(key, 10);
  if (Number.isNaN(digit) || digit < 1 || digit > 9) {
    return false;
  }
  return digit - 1 < question.options.length;
}

export function derivePendingUserInputProgress(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
  questionIndex: number,
): PendingUserInputProgress {
  const normalizedQuestionIndex =
    questions.length === 0 ? 0 : Math.max(0, Math.min(questionIndex, questions.length - 1));
  const activeQuestion = questions[normalizedQuestionIndex] ?? null;
  const activeDraft = activeQuestion ? draftAnswers[activeQuestion.id] : undefined;
  const resolvedAnswer = activeQuestion
    ? resolvePendingUserInputAnswer(activeQuestion, activeDraft)
    : null;
  const customAnswer = activeDraft?.customAnswer ?? "";
  const answeredQuestionCount = countAnsweredPendingUserInputQuestions(questions, draftAnswers);
  const isLastQuestion =
    questions.length === 0 ? true : normalizedQuestionIndex >= questions.length - 1;
  const isComplete = buildPendingUserInputAnswers(questions, draftAnswers) !== null;

  return {
    questionIndex: normalizedQuestionIndex,
    activeQuestion,
    activeDraft,
    selectedOptionLabels: normalizeSelectedOptionLabels(activeDraft?.selectedOptionLabels),
    customAnswer,
    resolvedAnswer,
    usingCustomAnswer: customAnswer.trim().length > 0,
    answeredQuestionCount,
    isLastQuestion,
    isComplete,
    canAdvance: Boolean(resolvedAnswer),
    firstUnansweredQuestionIndex: isComplete
      ? null
      : findFirstUnansweredPendingUserInputQuestionIndex(questions, draftAnswers),
  };
}

/** The outcome of pressing the prompt's primary control. */
export type PendingUserInputAdvance =
  | { kind: "blocked" }
  | { kind: "submit" }
  | { kind: "go-to-question"; questionIndex: number };

/**
 * What pressing that control does, given the question on screen and the
 * answers gathered so far.
 *
 * Pure, and separate from the component, because every entry point converges
 * here: the button, the Enter key, and a dictation delivered with submit
 * enabled. The Enter path in particular never consults the button's disabled
 * state, so a rule kept only in the markup was no rule at all.
 */
export function decidePendingUserInputAdvance(
  progress: PendingUserInputProgress,
): PendingUserInputAdvance {
  // Never leave the question on screen behind without an answer. Skipping it
  // stranded the whole prompt: the last question then refused to submit and
  // nothing said which answer was missing.
  if (!progress.canAdvance) {
    return { kind: "blocked" };
  }
  if (!progress.isLastQuestion) {
    return { kind: "go-to-question", questionIndex: progress.questionIndex + 1 };
  }
  if (progress.isComplete) {
    return { kind: "submit" };
  }
  // Last question answered, set still incomplete: an earlier answer is
  // missing, so go back to it rather than refusing silently. The null case
  // cannot arise from `derivePendingUserInputProgress`, which pairs a null
  // index with `isComplete`; it guards a hand-built progress value.
  return progress.firstUnansweredQuestionIndex === null
    ? { kind: "blocked" }
    : { kind: "go-to-question", questionIndex: progress.firstUnansweredQuestionIndex };
}
