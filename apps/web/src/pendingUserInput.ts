import type { ThreadContextRecord, UserInputQuestion } from "@t3tools/contracts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { formatThreadLink } from "@t3tools/shared/threadLinks";

import { collectInlineContextIds } from "./lib/composerContextReferences";

export function projectPendingUserInputAnswer(
  answer: unknown,
  threadContexts: ReadonlyArray<ThreadContextRecord>,
) {
  if (typeof answer !== "string" || threadContexts.length === 0) return answer;
  const recordsById = new Map(threadContexts.map((record) => [record.contextId, record]));
  return replaceComposerContextReferences(answer, (reference) => {
    const record = reference.kind === "thread" ? recordsById.get(reference.contextId) : undefined;
    return record ? formatThreadLink(record.threadId, reference.label) : reference.source;
  });
}

// Question drafts retain deleted chip records for undo; only transfer referenced records.
export function threadContextsReferencedByAnswer(
  answer: string,
  threadContexts: ReadonlyArray<ThreadContextRecord>,
) {
  const referencedIds = new Set(collectInlineContextIds(answer));
  return threadContexts.filter((record) => referencedIds.has(record.contextId));
}

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { PendingUserInput } from "./session-logic";
import { type PendingUserInputDraftAnswer, resolvePendingUserInputAnswer, buildPendingUserInputAnswers } from "@t3tools/client-runtime/user-input-answers";
export { type PendingUserInputDraftAnswer, resolvePendingUserInputAnswer, setPendingUserInputCustomAnswer, togglePendingUserInputOptionSelection, buildPendingUserInputAnswers } from "@t3tools/client-runtime/user-input-answers";
export interface PendingUserInputProgress {
  questionIndex: number;
  activeQuestion: UserInputQuestion | null;
  activeDraft: PendingUserInputDraftAnswer | undefined;
  selectedOptionValues: string[];
  customAnswer: string;
  resolvedAnswer: string | string[] | null;
  usingCustomAnswer: boolean;
  answeredQuestionCount: number;
  isLastQuestion: boolean;
  isComplete: boolean;
  canAdvance: boolean;
}

function normalizeSelectedOptionValues(value: readonly string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  // Provider option IDs must stay unchanged, including whitespace.
  return Array.from(new Set(value.filter((entry) => typeof entry === "string")));
}

export function pendingUserInputRequestKey(
  environmentId: string,
  threadId: string | null,
  requestId: string | undefined,
): string {
  return JSON.stringify([environmentId, threadId, requestId]);
}

/** Drops a thread's drafts for requests that are no longer pending. Unchanged input is returned as is. */
export function pruneResolvedUserInputDrafts<T>(
  draftsByRequestKey: Record<string, T>,
  environmentId: string,
  threadId: string,
  pendingRequestIds: ReadonlyArray<string>,
): Record<string, T> {
  const threadPrefix = JSON.stringify([environmentId, threadId]).slice(0, -1);
  const pendingKeys = new Set(
    pendingRequestIds.map((requestId) =>
      pendingUserInputRequestKey(environmentId, threadId, requestId),
    ),
  );
  const retained = Object.entries(draftsByRequestKey).filter(
    ([key]) => !key.startsWith(threadPrefix) || pendingKeys.has(key),
  );
  return retained.length === Object.keys(draftsByRequestKey).length
    ? draftsByRequestKey
    : Object.fromEntries(retained);
}

const DISPLACED_ANSWER_SEPARATOR = "\n\n";

export function carryDisplacedCustomAnswerIntoPrompt(
  prompt: string,
  customAnswer: string | undefined,
): string {
  const displaced = customAnswer?.trim() ?? "";
  if (displaced.length === 0) {
    return prompt;
  }
  if (prompt.trim().length === 0) {
    return displaced;
  }
  return `${prompt.trimEnd()}${DISPLACED_ANSWER_SEPARATOR}${displaced}`;
}

function countAnsweredPendingUserInputQuestions(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  return questions.reduce((count, question) => {
    return resolvePendingUserInputAnswer(question, draftAnswers[question.id]) !== null
      ? count + 1
      : count;
  }, 0);
}

export function findFirstUnansweredPendingUserInputQuestionIndex(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  const unansweredIndex = questions.findIndex(
    (question) => resolvePendingUserInputAnswer(question, draftAnswers[question.id]) === null,
  );

  return unansweredIndex === -1 ? Math.max(questions.length - 1, 0) : unansweredIndex;
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
  const customAnswer =
    activeQuestion?.allowCustomAnswer === false ? "" : (activeDraft?.customAnswer ?? "");
  const answeredQuestionCount = countAnsweredPendingUserInputQuestions(questions, draftAnswers);
  const isLastQuestion =
    questions.length === 0 ? true : normalizedQuestionIndex >= questions.length - 1;

  return {
    questionIndex: normalizedQuestionIndex,
    activeQuestion,
    activeDraft,
    selectedOptionValues: normalizeSelectedOptionValues(activeDraft?.selectedOptionValues),
    customAnswer,
    resolvedAnswer,
    usingCustomAnswer:
      (activeQuestion?.initialAnswer !== undefined ? customAnswer : customAnswer.trim()).length > 0,
    answeredQuestionCount,
    isLastQuestion,
    isComplete: buildPendingUserInputAnswers(questions, draftAnswers) !== null,
    canAdvance: resolvedAnswer !== null,
  };
}
const EMPTY_PENDING_USER_INPUTS: ReadonlyArray<PendingUserInput> = [];

/** Retain request identities across unrelated thread updates. */
export function createPendingUserInputProjection() {
  let previous = EMPTY_PENDING_USER_INPUTS;
  return (next: typeof previous): typeof previous => {
    const stable = next.map((request) => {
      const existing = previous.find((entry) => entry.requestId === request.requestId);
      return existing && JSON.stringify(existing) === JSON.stringify(request) ? existing : request;
    });
    if (stable.length === 0) return (previous = EMPTY_PENDING_USER_INPUTS);
    if (
      stable.length === previous.length &&
      stable.every((request, index) => request === previous[index])
    )
      return previous;
    return (previous = stable);
  };
}
