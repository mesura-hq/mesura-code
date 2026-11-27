import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  onThreadRequestsResolved,
  pruneResolvedUserInputDrafts,
  userInputDraftKey,
} from "@t3tools/client-runtime/state/thread-requests";
import type {
  EnvironmentId,
  ThreadContextRecord,
  ThreadId,
  UserInputQuestion,
} from "@t3tools/contracts";
import {
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "./pendingUserInput";
import {
  appendUnsentAnswersToThreadDraft,
  questionAttachmentDraftId,
  questionAttachmentDraftPrefix,
  setBeforeQuestionDraftsPruned,
} from "./questionAttachments";
import {
  otherTabChangedThreadDraft,
  persistComposerDrafts,
  useComposerDraftStore,
} from "./composerDraftStore";
import { findDictationSlots, removeDictationSlot } from "@t3tools/shared/dictationSlots";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { disarmSendWhenReady } from "./dictation/sendWhenReady";
import { armedThreadAvailability } from "./dictation/armedThreadHold";

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

function setRecoveryPending(keys: ReadonlyArray<string>) {
  if (keys.length === 0) return;
  try {
    usePendingUserInputDraftStore.setState((state) => {
      const requests = { ...state.requests };
      for (const key of keys) {
        const draft = requests[key];
        if (draft && !draft.recoveryPending) requests[key] = { ...draft, recoveryPending: true };
      }
      return { requests };
    });
  } catch {
    // A full storage: the answer stays in this tab's memory, unmarked.
  }
}

/** The thread's request keys whose answer still waits to return to the composer. */
function recoveryPendingKeys(environmentId: string, threadId: string): string[] {
  const threadPrefix = JSON.stringify([environmentId, threadId]).slice(0, -1);
  return Object.entries(usePendingUserInputDraftStore.getState().requests).flatMap(
    ([key, draft]) => (draft.recoveryPending && key.startsWith(threadPrefix) ? [key] : []),
  );
}

const requestIdOfKey = (key: string) => (JSON.parse(key) as [string, string, string])[2];

/** The answers a resolution may return: closed unanswered, or waiting from an earlier one. */
function recoveryCandidates(
  environmentId: string,
  threadId: string,
  unansweredRequestIds: ReadonlyArray<string>,
): string[] {
  return [
    ...new Set([
      ...Object.keys(recoverableAnswerDrafts(environmentId, threadId, unansweredRequestIds)),
      ...recoveryPendingKeys(environmentId, threadId),
    ]),
  ].map(requestIdOfKey);
}

/**
 * The chips of the questions whose answers wait to return, by question draft id. Upstream prunes
 * those drafts on the resolution itself, before the locked recovery below runs.
 */
const keptThreadContexts = new Map<string, ReadonlyArray<ThreadContextRecord>>();

setBeforeQuestionDraftsPruned(({ environmentId, threadId, unansweredRequestIds }) => {
  reloadPersistedAnswerDrafts();
  const { requests } = usePendingUserInputDraftStore.getState();
  const composer = useComposerDraftStore.getState();
  for (const requestId of recoveryCandidates(environmentId, threadId, unansweredRequestIds)) {
    const answers = requests[userInputDraftKey(environmentId, threadId, requestId)]?.answers ?? {};
    for (const questionId of Object.keys(answers)) {
      const draftId = questionAttachmentDraftId(environmentId, threadId, requestId, questionId);
      const contexts = composer.getComposerDraft(draftId)?.threadContexts ?? [];
      if (contexts.length > 0) keptThreadContexts.set(draftId, contexts);
    }
  }
});

/** Held by the tab returning answers; tests take it to wait for the queued recoveries. */
export const ANSWER_RECOVERY_LOCK = "mesura:question-answer-recovery";

/**
 * Every tab with the thread open gets the same announcement, and localStorage reaches other tabs
 * late, so only a lock shared by the origin's tabs stops two of them appending one answer. Inside
 * it the answer is reloaded, claimed (taken out of storage) and only then appended.
 */
function recoverThreadAnswersOneTabAtATime(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  requestIds: ReadonlyArray<string>,
) {
  const run = () => recoverThreadAnswers(environmentId, threadId, requestIds);
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (locks === undefined) return run();
  void locks.request(ANSWER_RECOVERY_LOCK, run);
}

function recoverThreadAnswers(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  requestIds: ReadonlyArray<string>,
) {
  reloadPersistedAnswerDrafts();
  const recoverable = recoverableAnswerDrafts(environmentId, threadId, requestIds);
  const keys = Object.keys(recoverable);
  if (keys.length === 0) return;
  // Appending to this tab's stale copy of the composer would replace another tab's newer draft.
  if (otherTabChangedThreadDraft(scopeThreadRef(environmentId, threadId))) {
    setRecoveryPending(keys);
    return;
  }
  const { requests } = usePendingUserInputDraftStore.getState();
  const claimed = new Map(keys.map((key) => [key, requests[key]!] as const));
  const remaining = { ...requests };
  for (const key of keys) delete remaining[key];
  usePendingUserInputDraftStore.setState({ requests: remaining });
  appendUnsentAnswersToThreadDraft(
    environmentId,
    threadId,
    keys.flatMap((key) =>
      Object.entries(recoverable[key]!).map(([questionId, { customAnswer }]) => {
        const draftId = questionAttachmentDraftId(
          environmentId,
          threadId,
          requestIdOfKey(key),
          questionId,
        );
        const threadContexts = keptThreadContexts.get(draftId) ?? [];
        keptThreadContexts.delete(draftId);
        return { customAnswer, threadContexts };
      }),
    ),
  );
  // An armed composer send would carry the recovered answer with it; the user reviews it first.
  disarmSendWhenReady(scopeThreadRef(environmentId, threadId));
  if (persistComposerDrafts()) return;
  // Unsaved, the composer copy may not survive; the answers go back, marked, rather than lost.
  reloadPersistedAnswerDrafts();
  try {
    usePendingUserInputDraftStore.setState((state) => {
      const next = { ...state.requests };
      for (const [key, draft] of claimed) next[key] = { ...draft, recoveryPending: true };
      return { requests: next };
    });
  } catch {
    // Nothing more can be saved; the composer still shows the answer in this tab.
  }
}

// Announced from a synchronized projection only, and on deletion, so a cached snapshot that
// predates a question never prunes its answer.
onThreadRequestsResolved(({ environmentId, threadId, pendingRequestIds, unansweredRequestIds }) => {
  reloadPersistedAnswerDrafts();
  const { requests } = usePendingUserInputDraftStore.getState();
  // A deleted thread has no composer to return answers to: its drafts go, waiting ones included.
  // Its announcement carries the same empty payload as a live projection without requests.
  if (armedThreadAvailability(scopeThreadRef(environmentId, threadId)) === "gone") {
    const threadDraftPrefix = questionAttachmentDraftPrefix(environmentId, threadId);
    for (const draftId of keptThreadContexts.keys())
      if (draftId.startsWith(threadDraftPrefix)) keptThreadContexts.delete(draftId);
    const pruned = pruneResolvedUserInputDrafts(requests, environmentId, threadId, []);
    if (pruned !== requests) usePendingUserInputDraftStore.setState({ requests: pruned });
    return;
  }
  // Answers to return, including ones that waited: their request may have left the projection.
  const candidates = recoveryCandidates(environmentId, threadId, unansweredRequestIds);
  const pruned = pruneResolvedUserInputDrafts(requests, environmentId, threadId, [
    ...pendingRequestIds,
    ...candidates,
  ]);
  if (pruned !== requests) usePendingUserInputDraftStore.setState({ requests: pruned });
  if (candidates.length > 0) recoverThreadAnswersOneTabAtATime(environmentId, threadId, candidates);
});
