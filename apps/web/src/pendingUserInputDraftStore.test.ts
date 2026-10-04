// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it } from "vite-plus/test";

import { usePendingUserInputDraftStore } from "./pendingUserInputDraftStore";

const STORAGE_KEY = "mesura-pending-question-drafts";

// Version 2 saved drafts carried `dictationCommands`, the ledger of Symmetria Shell transcripts,
// and could carry an `error` written before `partialize` started stripping it.
const versionTwoStorage = {
  version: 2,
  state: {
    requests: {
      "request-a": {
        answers: {
          scope: { customAnswer: "Only the web app", selectedOptionValues: ["web"] },
          timing: { selectedOptionValues: ["now", "later"] },
        },
        error: { kind: "respond", message: "Disconnected" },
        dictationCommands: ["command-from-shell-1", "command-from-shell-2"],
        voicedQuestionIds: ["scope"],
        version: 7,
      },
      "request-b": {
        answers: { notes: { customAnswer: "Second request answer" } },
        dictationCommands: [],
        version: 2,
      },
    },
  },
};

beforeEach(() => {
  localStorage.clear();
  usePendingUserInputDraftStore.setState({ requests: {} });
});

afterEach(() => {
  localStorage.clear();
});

it("pending question drafts saved at version 2 keep their answers and drop the Shell dictation ledger on load", async () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(versionTwoStorage));

  await usePendingUserInputDraftStore.persist.rehydrate();

  expect(usePendingUserInputDraftStore.getState().requests).toEqual({
    "request-a": {
      answers: {
        scope: { customAnswer: "Only the web app", selectedOptionValues: ["web"] },
        timing: { selectedOptionValues: ["now", "later"] },
      },
      voicedQuestionIds: ["scope"],
      version: 7,
    },
    "request-b": {
      answers: { notes: { customAnswer: "Second request answer" } },
      version: 2,
    },
  });

  const rewritten = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as {
    version: number;
    state: { requests: Record<string, Record<string, unknown>> };
  };
  expect(rewritten.version).toBe(3);
  expect(rewritten.state.requests["request-a"]).not.toHaveProperty("dictationCommands");
  expect(rewritten.state.requests["request-a"]).not.toHaveProperty("error");
  expect(rewritten.state.requests["request-b"]).not.toHaveProperty("dictationCommands");
  expect(rewritten.state.requests["request-a"]?.["answers"]).toEqual(
    versionTwoStorage.state.requests["request-a"].answers,
  );
});
