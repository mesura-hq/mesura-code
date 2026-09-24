import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CommandId, UserInputQuestion } from "@t3tools/contracts";
import {
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "./pendingUserInput";
import { appendComposerTextAtEnd } from "./symmetria/dictationTarget";

export { pendingUserInputRequestKey } from "./pendingUserInput";

export const EMPTY_QUESTION_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
export type PendingUserInputError = { kind: "respond" | "dismiss"; message: string };
interface RequestDraft {
  answers: Record<string, PendingUserInputDraftAnswer>;
  error?: PendingUserInputError | null;
  dictationCommands: string[];
  version: number;
}

function durableRequests(requests: Record<string, RequestDraft>) {
  return Object.fromEntries(
    Object.entries(requests).map(([key, { error: _error, ...draft }]) => [key, draft]),
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
      appendTranscript: (
        key: string,
        question: UserInputQuestion,
        commandId: CommandId,
        text: string,
      ) => { application: "first" | "replay"; version: number };
      clear: (key: string) => void;
      setError: (key: string, error: PendingUserInputError | null) => void;
    },
    [],
    [],
    { requests: Record<string, RequestDraft> }
  >(
    (set, get) => ({
      requests: {},
      update: (key, question, update) =>
        set((state) => {
          const current = state.requests[key] ?? { answers: {}, dictationCommands: [], version: 0 };
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
      appendTranscript: (key, question, commandId, text) => {
        const current = get().requests[key];
        if (current?.dictationCommands.includes(commandId))
          return { application: "replay", version: current.version };
        get().update(key, question, {
          text: appendComposerTextAtEnd(
            current?.answers[question.id]?.customAnswer ?? "",
            `[voiced] ${text}`,
          ),
        });
        const next = get().requests[key]!;
        set((state) => ({
          requests: {
            ...state.requests,
            [key]: {
              ...next,
              dictationCommands: [...next.dictationCommands, commandId].slice(-64),
            },
          },
        }));
        return { application: "first", version: next.version };
      },
      setError: (key, error) =>
        set((state) => ({
          requests: {
            ...state.requests,
            [key]: {
              answers: {},
              dictationCommands: [],
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
      version: 2,
      partialize: (state) => ({ requests: durableRequests(state.requests) }),
      migrate: (persisted) => {
        const state = persisted as { requests?: Record<string, RequestDraft> };
        return { ...state, requests: durableRequests(state.requests ?? {}) };
      },
    },
  ),
);
