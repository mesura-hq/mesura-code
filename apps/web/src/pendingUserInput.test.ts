import { describe, expect, it } from "vite-plus/test";

import {
  buildPendingUserInputAnswers,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "./pendingUserInput";

const singleSelectQuestion = {
  id: "scope",
  header: "Scope",
  question: "What should the plan target first?",
  options: [
    {
      label: "Orchestration-first",
      description: "Focus on orchestration first",
    },
  ],
  multiSelect: false,
} as const;

const multiSelectQuestion = {
  id: "areas",
  header: "Areas",
  question: "Which areas should this change cover?",
  options: [
    {
      label: "Server",
      description: "Server",
    },
    {
      label: "Web",
      description: "Web",
    },
  ],
  multiSelect: true,
} as const;

const nativeChoiceQuestion = {
  id: "result",
  header: "Result",
  question: "Which result should be used?",
  options: [
    { value: " first\t", label: "Result", description: "First result" },
    { value: "second", label: "Result", description: "Second result" },
  ],
  allowCustomAnswer: false,
  multiSelect: false,
} as const;

describe("resolvePendingUserInputAnswer", () => {
  it("keeps a custom answer with selected options", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        selectedOptionValues: ["Orchestration-first"],
        customAnswer: "Keep the existing envelope for one release",
      }),
    ).toEqual(["Orchestration-first", "Keep the existing envelope for one release"]);
  });

  it("falls back to the selected option for single-select questions", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        selectedOptionValues: ["Orchestration-first"],
      }),
    ).toBe("Orchestration-first");
  });

  it("returns all selected labels for multi-select questions", () => {
    expect(
      resolvePendingUserInputAnswer(multiSelectQuestion, {
        selectedOptionValues: ["Server", "Web"],
      }),
    ).toEqual(["Server", "Web"]);
  });

  it("keeps the preset selection when a custom answer is entered", () => {
    expect(
      setPendingUserInputCustomAnswer(
        multiSelectQuestion,
        {
          selectedOptionValues: ["Server", "Web"],
        },
        "doesn't matter",
      ),
    ).toEqual({
      customAnswer: "doesn't matter",
      selectedOptionValues: ["Server", "Web"],
    });
  });

  it("does not replace a required choice with a custom answer", () => {
    expect(
      resolvePendingUserInputAnswer(nativeChoiceQuestion, {
        selectedOptionValues: ["second"],
        customAnswer: "Use another result",
      }),
    ).toBe("second");
  });

  it("does not submit labels or unknown values when an option has a value", () => {
    expect(
      resolvePendingUserInputAnswer(nativeChoiceQuestion, {
        selectedOptionValues: ["Result", "unknown"],
      }),
    ).toBeNull();
  });
});

it("web draft keeps a single choice and note in one answer", () => {
  const selected = togglePendingUserInputOptionSelection(
    singleSelectQuestion,
    undefined,
    "Orchestration-first",
  );
  const draft = setPendingUserInputCustomAnswer(
    singleSelectQuestion,
    selected,
    "Keep the existing envelope",
  );
  expect(draft).toMatchObject({
    selectedOptionValues: ["Orchestration-first"],
    customAnswer: "Keep the existing envelope",
  });
  expect(buildPendingUserInputAnswers([singleSelectQuestion], { scope: draft })).toEqual({
    scope: ["Orchestration-first", "Keep the existing envelope"],
  });
});

it("web draft keeps multiple opaque values and a note unchanged", () => {
  const question = { ...nativeChoiceQuestion, multiSelect: true, allowCustomAnswer: true };
  const first = togglePendingUserInputOptionSelection(question, undefined, " first\t");
  const second = togglePendingUserInputOptionSelection(question, first, "second");
  const draft = setPendingUserInputCustomAnswer(question, second, "Use both results");
  expect(draft.selectedOptionValues).toEqual([" first\t", "second"]);
  expect(buildPendingUserInputAnswers([question], { result: draft })).toEqual({
    result: [" first\t", "second", "Use both results"],
  });
});

it("web draft waits for all text and attachment answers", () => {
  const textQuestion = { ...singleSelectQuestion, id: "text", options: [] };
  const attachmentQuestion = { ...singleSelectQuestion, id: "file", options: [] };
  const questions = [textQuestion, attachmentQuestion];
  const drafts = { text: { customAnswer: "Details" }, file: { attachmentCount: 1 } };
  expect(buildPendingUserInputAnswers(questions, drafts)).toEqual({ text: "Details", file: "" });
  expect(buildPendingUserInputAnswers(questions, { ...drafts, file: {} })).toBeNull();
  expect(
    buildPendingUserInputAnswers(questions, {
      ...drafts,
      file: { attachmentCount: 1, attachmentsBlocked: true },
    }),
  ).toBeNull();
  expect(
    buildPendingUserInputAnswers([{ ...attachmentQuestion, allowCustomAnswer: false }], {
      file: { attachmentCount: 1 },
    }),
  ).toBeNull();
});

it("web choice-only questions require an exact listed value", () => {
  expect(
    buildPendingUserInputAnswers([nativeChoiceQuestion], {
      result: { selectedOptionValues: [" first\t"] },
    }),
  ).toEqual({ result: " first\t" });
  for (const value of ["Result", " first ", "unknown"]) {
    expect(
      buildPendingUserInputAnswers([nativeChoiceQuestion], {
        result: { selectedOptionValues: [value], customAnswer: "Ignore this note" },
      }),
    ).toBeNull();
  }
});

describe("togglePendingUserInputOptionSelection", () => {
  it("toggles options for multi-select questions", () => {
    expect(togglePendingUserInputOptionSelection(multiSelectQuestion, undefined, "Server")).toEqual(
      {
        customAnswer: "",
        selectedOptionValues: ["Server"],
      },
    );

    expect(
      togglePendingUserInputOptionSelection(
        multiSelectQuestion,
        {
          selectedOptionValues: ["Server", "Web"],
        },
        "Server",
      ),
    ).toEqual({
      customAnswer: "",
      selectedOptionValues: ["Web"],
    });
  });

  it("selects and removes options with the same label independently", () => {
    const question = { ...nativeChoiceQuestion, multiSelect: true };
    const firstSelected = togglePendingUserInputOptionSelection(question, undefined, " first\t");
    const bothSelected = togglePendingUserInputOptionSelection(question, firstSelected, "second");

    expect(buildPendingUserInputAnswers([question], { result: bothSelected })).toEqual({
      result: [" first\t", "second"],
    });

    const secondSelected = togglePendingUserInputOptionSelection(
      question,
      bothSelected,
      " first\t",
    );
    expect(buildPendingUserInputAnswers([question], { result: secondSelected })).toEqual({
      result: ["second"],
    });
  });
});

describe("buildPendingUserInputAnswers", () => {
  it("returns a canonical answer map for complete prompts", () => {
    expect(
      buildPendingUserInputAnswers(
        [
          singleSelectQuestion,
          {
            id: "compat",
            header: "Compat",
            question: "How strict should compatibility be?",
            options: [
              {
                label: "Keep current envelope",
                description: "Preserve current wire format",
              },
            ],
            multiSelect: false,
          },
        ],
        {
          scope: {
            selectedOptionValues: ["Orchestration-first"],
          },
          compat: {
            customAnswer: "Keep the current envelope for one release window",
          },
        },
      ),
    ).toEqual({
      scope: "Orchestration-first",
      compat: "Keep the current envelope for one release window",
    });
  });

  it("returns arrays for answered multi-select prompts", () => {
    expect(
      buildPendingUserInputAnswers([multiSelectQuestion], {
        areas: {
          selectedOptionValues: ["Server", "Web"],
        },
      }),
    ).toEqual({
      areas: ["Server", "Web"],
    });
  });

  it("returns null when any question is unanswered", () => {
    expect(buildPendingUserInputAnswers([singleSelectQuestion], {})).toBeNull();
  });

  it.each([" first\t", ""])("preserves the exact selected option value %j", (value) => {
    const question = {
      ...nativeChoiceQuestion,
      options: [{ ...nativeChoiceQuestion.options[0], value }, nativeChoiceQuestion.options[1]],
    };
    const draft = togglePendingUserInputOptionSelection(question, undefined, value);

    expect(buildPendingUserInputAnswers([question], { result: draft })).toEqual({ result: value });
  });
});

it("accepts attachment-only answers after every upload finishes", () => {
  const questions = [
    { id: "spec", header: "Spec", question: "Provide a spec", options: [], multiSelect: false },
  ];
  expect(buildPendingUserInputAnswers(questions, { spec: { attachmentCount: 1 } })).toEqual({
    spec: "",
  });
  expect(
    buildPendingUserInputAnswers(questions, {
      spec: { attachmentCount: 1, attachmentsBlocked: true },
    }),
  ).toBeNull();
  expect(
    buildPendingUserInputAnswers([{ ...questions[0]!, allowCustomAnswer: false }], {
      spec: { attachmentCount: 1 },
    }),
  ).toBeNull();
});

it("web shared setter refuses notes for an exact choice-only draft", () => {
  const draft = { selectedOptionValues: [" first\t"] };
  expect(setPendingUserInputCustomAnswer(nativeChoiceQuestion, draft, "Do not send")).toBe(draft);
  expect(buildPendingUserInputAnswers([nativeChoiceQuestion], { result: draft })).toEqual({
    result: " first\t",
  });
});
