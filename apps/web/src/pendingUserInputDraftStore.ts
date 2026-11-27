import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  onThreadRequestsResolved,
  pruneResolvedUserInputDrafts,
  userInputDraftKey,
} from "@t3tools/client-runtime/state/thread-requests";
import type { RuntimeRequestId, UserInputQuestion } from "@t3tools/contracts";
import {
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "./pendingUserInput";
import {
  returnUnsentAnswersToThreadDraft,
  setInlineAnswerDraftSource,
} from "./questionAttachments";
import { otherTabChangedThreadDraft, persistComposerDrafts } from "./composerDraftStore";
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
  /**
   * The question closed unanswered, but its answer could not return to the composer yet (another
   * tab changed that draft). Kept, and retried on the thread's next announcement.
   */
  recoveryPending?: true;
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

/**
 * Every write replaces the whole persisted map, so a write this tab makes on its own (not from the
 * user's typing here) first takes in what other tabs saved since. Storage keeps no errors; the
 * ones this tab shows stay. Synchronous with localStorage.
 */
export function reloadPersistedAnswerDrafts(): void {
  const before = usePendingUserInputDraftStore.getState().requests;
  void usePendingUserInputDraftStore.persist.rehydrate();
  const reloaded = usePendingUserInputDraftStore.getState().requests;
  const requests = { ...reloaded };
  let kept = false;
  for (const [key, draft] of Object.entries(before)) {
    const reloadedDraft = reloaded[key];
    if (!draft.error || reloadedDraft === undefined) continue;
    requests[key] = { ...reloadedDraft, error: draft.error };
    kept = true;
  }
  if (!kept) return;
  usePendingUserInputDraftStore.setState({ requests });
}

type AnswerDraftsByRequestKey = Record<string, Record<string, PendingUserInputDraftAnswer>>;

/** The thread's unanswered requests whose saved answers hold text once markers are dropped. */
function recoverableAnswerDrafts(
  environmentId: string,
  threadId: string,
  unansweredRequestIds: ReadonlyArray<string>,
): AnswerDraftsByRequestKey {
  const { requests } = usePendingUserInputDraftStore.getState();
  const recoverable: AnswerDraftsByRequestKey = {};
  for (const requestId of unansweredRequestIds) {
    const key = userInputDraftKey(environmentId, threadId, requestId);
    const draft = requests[key];
    if (!draft) continue;
    const answers = Object.fromEntries(
      Object.entries(draft.answers).map(([questionId, answer]) => [
        questionId,
        answer.customAnswer === undefined
          ? answer
          : { ...answer, customAnswer: withoutDictationMarkers(answer.customAnswer) },
      ]),
    );
    if (Object.values(answers).some((answer) => (answer.customAnswer ?? "").trim() !== ""))
      recoverable[key] = answers;
  }
  return recoverable;
}

/** Request keys the recovery source handed to the composer in the running announcement. */
const recoveringKeys = new Set<string>();

function setRecoveryPending(keys: Iterable<string>) {
  const marked = [...keys];
  if (marked.length === 0) return;
  usePendingUserInputDraftStore.setState((state) => {
    const requests = { ...state.requests };
    for (const key of marked) {
      const draft = requests[key];
      if (draft && !draft.recoveryPending) requests[key] = { ...draft, recoveryPending: true };
    }
    return { requests };
  });
}

/** The thread's request keys whose answer still waits to return to the composer. */
function recoveryPendingKeys(environmentId: string, threadId: string): string[] {
  const threadPrefix = JSON.stringify([environmentId, threadId]).slice(0, -1);
  return Object.entries(usePendingUserInputDraftStore.getState().requests).flatMap(
    ([key, draft]) => (draft.recoveryPending && key.startsWith(threadPrefix) ? [key] : []),
  );
}

const requestIdOfKey = (key: string) => (JSON.parse(key) as [string, string, string])[2];

// Upstream's recovery returns a cancelled or expired question's typed answer to the composer. It
// reads the newest saved answers. When another tab changed that composer draft, appending to this
// tab's copy would replace it, so the answer stays saved and marked for a later announcement.
setInlineAnswerDraftSource((environmentId, threadId, unansweredRequestIds) => {
  reloadPersistedAnswerDrafts();
  const recoverable = recoverableAnswerDrafts(environmentId, threadId, unansweredRequestIds);
  const keys = Object.keys(recoverable);
  if (keys.length === 0) return {};
  if (otherTabChangedThreadDraft(scopeThreadRef(environmentId, threadId))) {
    setRecoveryPending(keys);
    return {};
  }
  for (const key of keys) recoveringKeys.add(key);
  return recoverable;
});

// Announced from a synchronized projection only, and on deletion, so a cached snapshot that
// predates a question never prunes its answer. Registered after upstream's listener (this module
// imports it), whose recovery runs the source above for the same announcement first.
onThreadRequestsResolved(({ environmentId, threadId, pendingRequestIds }) => {
  reloadPersistedAnswerDrafts();
  // An answer that waited is retried here: its request may no longer be in the projection at all.
  const waiting = recoveryPendingKeys(environmentId, threadId).filter(
    (key) => !recoveringKeys.has(key),
  );
  if (waiting.length > 0)
    returnUnsentAnswersToThreadDraft(
      environmentId,
      threadId,
      waiting.map((key) => requestIdOfKey(key) as RuntimeRequestId),
    );
  const recovering = [...recoveringKeys];
  recoveringKeys.clear();
  const { requests } = usePendingUserInputDraftStore.getState();
  const stillWaiting = recoveryPendingKeys(environmentId, threadId)
    .filter((key) => !recovering.includes(key))
    .map(requestIdOfKey);
  const pruned = pruneResolvedUserInputDrafts(requests, environmentId, threadId, [
    ...pendingRequestIds,
    ...stillWaiting,
  ]);
  if (pruned === requests) return;
  if (recovering.length > 0) {
    // An armed composer send would carry the recovered answer with it; the user reviews it first.
    disarmSendWhenReady(scopeThreadRef(environmentId, threadId));
    // Unsaved, the composer copy may not survive; the answer stays marked rather than lost.
    if (!persistComposerDrafts()) {
      setRecoveryPending(recovering);
      return;
    }
  }
  usePendingUserInputDraftStore.setState({ requests: pruned });
});
