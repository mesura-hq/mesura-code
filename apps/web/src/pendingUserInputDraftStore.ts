import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  onThreadRequestsResolved,
  pruneResolvedUserInputDrafts,
  userInputDraftKey,
} from "@t3tools/client-runtime/state/thread-requests";
import type { UserInputQuestion } from "@t3tools/contracts";
import {
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "./pendingUserInput";
import { setInlineAnswerDraftSource } from "./questionAttachments";
import { persistComposerDrafts } from "./composerDraftStore";
import { findDictationSlots, removeDictationSlot } from "@t3tools/shared/dictationSlots";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { disarmSendWhenReady } from "./dictation/sendWhenReady";

export { pendingUserInputRequestKey } from "./pendingUserInput";

export const EMPTY_QUESTION_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
export type PendingUserInputError = { kind: "respond" | "dismiss"; message: string };
interface RequestDraft {
  answers: Record<string, PendingUserInputDraftAnswer>;
  error?: PendingUserInputError | null;
  /** Questions whose typed answer holds dictated text; their answer carries `[voiced] `. */
  voicedQuestionIds?: string[];
  version: number;
}

/**
 * What a request draft keeps across reloads. Version 2 drafts also carried `dictationCommands`,
 * the ledger of Symmetria Shell transcripts, which is dropped here on load.
 */
function durableRequests(requests: Record<string, RequestDraft>) {
  return Object.fromEntries(
    Object.entries(requests).map(([key, draft]) => {
      const {
        error: _error,
        dictationCommands: _dictationCommands,
        ...durable
      } = draft as RequestDraft & { dictationCommands?: unknown };
      return [key, durable];
    }),
  );
}

/** Request drafts outlive virtualized rows, thread navigation, and reconnects. */
export const usePendingUserInputDraftStore = create(
  persist<
    {
      requests: Record<string, RequestDraft>;
      update: (
        key: string,
        question: UserInputQuestion,
        update: { text: string } | { option: string },
      ) => void;
      clear: (key: string) => void;
      setError: (key: string, error: PendingUserInputError | null) => void;
    },
    [],
    [],
    { requests: Record<string, RequestDraft> }
  >(
    (set) => ({
      requests: {},
      update: (key, question, update) =>
        set((state) => {
          const current = state.requests[key] ?? { answers: {}, version: 0 };
          const answer =
            "text" in update
              ? setPendingUserInputCustomAnswer(question, current.answers[question.id], update.text)
              : togglePendingUserInputOptionSelection(
                  question,
                  current.answers[question.id],
                  update.option,
                );
          return {
            requests: {
              ...state.requests,
              [key]: {
                ...current,
                answers: { ...current.answers, [question.id]: answer },
                version: current.version + 1,
              },
            },
          };
        }),
      setError: (key, error) =>
        set((state) => ({
          requests: {
            ...state.requests,
            [key]: {
              answers: {},
              version: 0,
              ...state.requests[key],
              error,
            },
          },
        })),
      clear: (key) =>
        set((state) => {
          if (!(key in state.requests)) return state;
          const requests = { ...state.requests };
          delete requests[key];
          return { requests };
        }),
    }),
    {
      name: "mesura-pending-question-drafts",
      version: 3,
      partialize: (state) => ({ requests: durableRequests(state.requests) }),
      migrate: (persisted) => {
        const state = persisted as { requests?: Record<string, RequestDraft> };
        return { ...state, requests: durableRequests(state.requests ?? {}) };
      },
    },
  ),
);

/**
 * Rewrites one question's typed answer; `edit` returns `null` to leave it alone. Used for
 * dictation markers, which reach an answer whether or not its card is mounted. Returns whether
 * the answer changed.
 */
export function editPendingUserInputAnswerText(
  key: string,
  questionId: string,
  edit: (text: string) => string | null,
): boolean {
  const current = usePendingUserInputDraftStore.getState().requests[key] ?? {
    answers: {},
    version: 0,
  };
  const answer = current.answers[questionId];
  const text = edit(answer?.customAnswer ?? "");
  if (text === null || text === (answer?.customAnswer ?? "")) return false;
  usePendingUserInputDraftStore.setState((state) => ({
    requests: {
      ...state.requests,
      [key]: {
        ...current,
        answers: { ...current.answers, [questionId]: { ...answer, customAnswer: text } },
        version: current.version + 1,
      },
    },
  }));
  return true;
}

export function readPendingUserInputAnswerText(key: string, questionId: string): string {
  return (
    usePendingUserInputDraftStore.getState().requests[key]?.answers[questionId]?.customAnswer ?? ""
  );
}

/** Records that a transcript was filled into one question's answer. */
export function markPendingUserInputAnswerVoiced(key: string, questionId: string): void {
  usePendingUserInputDraftStore.setState((state) => {
    const current = state.requests[key];
    if (!current || current.voicedQuestionIds?.includes(questionId)) return state;
    return {
      requests: {
        ...state.requests,
        [key]: {
          ...current,
          voicedQuestionIds: [...(current.voicedQuestionIds ?? []), questionId],
        },
      },
    };
  });
}

/** A pending marker's job targets the question, so it could never fill in the composer. */
function withoutDictationMarkers(text: string): string {
  let result = text;
  for (const { jobId } of findDictationSlots(text)) {
    const removed = removeDictationSlot(result, jobId);
    if (!("missing" in removed)) result = removed.text;
  }
  return result;
}

// Upstream's recovery returns a cancelled or expired question's typed answer to the composer.
setInlineAnswerDraftSource(() =>
  Object.fromEntries(
    Object.entries(usePendingUserInputDraftStore.getState().requests).map(([key, draft]) => [
      key,
      Object.fromEntries(
        Object.entries(draft.answers).map(([questionId, answer]) => [
          questionId,
          answer.customAnswer === undefined
            ? answer
            : { ...answer, customAnswer: withoutDictationMarkers(answer.customAnswer) },
        ]),
      ),
    ]),
  ),
);

// Announced from a synchronized projection only, and on deletion, so a cached snapshot that
// predates a question never prunes its answer. Registered after upstream's listener (this module
// imports it), which has already moved a cancelled answer to the composer.
onThreadRequestsResolved(({ environmentId, threadId, pendingRequestIds, unansweredRequestIds }) => {
  const { requests } = usePendingUserInputDraftStore.getState();
  const pruned = pruneResolvedUserInputDrafts(requests, environmentId, threadId, pendingRequestIds);
  if (pruned === requests) return;
  // The whole map is written back, so start from storage: another tab may have saved answers since
  // this one last wrote. With synchronous storage, rehydration lands before the next line.
  void usePendingUserInputDraftStore.persist.rehydrate();
  // Storage keeps no errors; the ones this tab shows stay.
  const latest = Object.fromEntries(
    Object.entries(usePendingUserInputDraftStore.getState().requests).map(([key, draft]) => {
      const error = requests[key]?.error;
      return [key, error ? { ...draft, error } : draft];
    }),
  );
  const recovered = unansweredRequestIds.some((requestId) =>
    Object.values(
      requests[userInputDraftKey(environmentId, threadId, requestId)]?.answers ?? {},
    ).some((answer) => withoutDictationMarkers(answer.customAnswer ?? "").trim() !== ""),
  );
  // An armed composer send would carry the recovered answer with it; the user reviews it first.
  if (recovered) disarmSendWhenReady(scopeThreadRef(environmentId, threadId));
  // Keeping the answer when the composer cannot be saved risks a duplicate later, never a loss.
  if (recovered && !persistComposerDrafts()) return;
  usePendingUserInputDraftStore.setState({
    requests: pruneResolvedUserInputDrafts(latest, environmentId, threadId, pendingRequestIds),
  });
});
