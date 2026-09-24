import { expect, it } from "vite-plus/test";
import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "./userInputAnswers.ts";

const question = {
  id: "scope",
  header: "Scope",
  question: "Scope?",
  multiSelect: false,
  options: [{ label: "Workspace", description: "Workspace", value: " Workspace\t" }],
};

it("shared draft preserves attachment blocking while editing both answer parts", () => {
  const initial = { attachmentCount: 1, attachmentsBlocked: true };
  const noted = setPendingUserInputCustomAnswer(question, initial, "Keep files");
  const selected = togglePendingUserInputOptionSelection(question, noted, " Workspace\t");
  expect(selected).toEqual({
    ...initial,
    customAnswer: "Keep files",
    selectedOptionValues: [" Workspace\t"],
  });
  expect(buildPendingUserInputAnswers([question], { scope: selected })).toBeNull();
  expect(
    buildPendingUserInputAnswers([question], { scope: { ...selected, attachmentsBlocked: false } }),
  ).toEqual({ scope: [" Workspace\t", "Keep files"] });
});

it("shared custom-answer setter leaves choice-only drafts unchanged", () => {
  const choiceOnly = { ...question, allowCustomAnswer: false };
  const draft = { selectedOptionValues: [" Workspace\t"], attachmentCount: 0 };
  expect(setPendingUserInputCustomAnswer(choiceOnly, draft, "Cannot send this note")).toBe(draft);
  expect(setPendingUserInputCustomAnswer(choiceOnly, undefined, "Cannot send this note")).toEqual(
    {},
  );
});
