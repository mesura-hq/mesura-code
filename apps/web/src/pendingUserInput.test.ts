import { describe, expect, it } from "vite-plus/test";

import {
  buildPendingUserInputAnswers,
  countAnsweredPendingUserInputQuestions,
  decidePendingUserInputAdvance,
  isPendingUserInputOptionShortcut,
  derivePendingUserInputProgress,
  findFirstUnansweredPendingUserInputQuestionIndex,
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

describe("resolvePendingUserInputAnswer", () => {
  it("prefers a custom answer over selected options", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        selectedOptionLabels: ["Orchestration-first"],
        customAnswer: "Keep the existing envelope for one release",
      }),
    ).toBe("Keep the existing envelope for one release");
  });

  it("falls back to the selected option for single-select questions", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        selectedOptionLabels: ["Orchestration-first"],
      }),
    ).toBe("Orchestration-first");
  });

  it("returns all selected labels for multi-select questions", () => {
    expect(
      resolvePendingUserInputAnswer(multiSelectQuestion, {
        selectedOptionLabels: ["Server", "Web"],
      }),
    ).toEqual(["Server", "Web"]);
  });

  it("clears the preset selection when a custom answer is entered", () => {
    expect(
      setPendingUserInputCustomAnswer(
        {
          selectedOptionLabels: ["Server", "Web"],
        },
        "doesn't matter",
      ),
    ).toEqual({
      customAnswer: "doesn't matter",
    });
  });
});

describe("togglePendingUserInputOptionSelection", () => {
  it("toggles options for multi-select questions", () => {
    expect(togglePendingUserInputOptionSelection(multiSelectQuestion, undefined, "Server")).toEqual(
      {
        customAnswer: "",
        selectedOptionLabels: ["Server"],
      },
    );

    expect(
      togglePendingUserInputOptionSelection(
        multiSelectQuestion,
        {
          selectedOptionLabels: ["Server", "Web"],
        },
        "Server",
      ),
    ).toEqual({
      customAnswer: "",
      selectedOptionLabels: ["Web"],
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
            selectedOptionLabels: ["Orchestration-first"],
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
          selectedOptionLabels: ["Server", "Web"],
        },
      }),
    ).toEqual({
      areas: ["Server", "Web"],
    });
  });

  it("returns null when any question is unanswered", () => {
    expect(buildPendingUserInputAnswers([singleSelectQuestion], {})).toBeNull();
  });
});

describe("pending user input question progress", () => {
  const questions = [
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
  ] as const;

  it("counts only answered questions", () => {
    expect(
      countAnsweredPendingUserInputQuestions(questions, {
        scope: {
          selectedOptionLabels: ["Orchestration-first"],
        },
      }),
    ).toBe(1);
  });

  it("finds the first unanswered question", () => {
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(questions, {
        scope: {
          selectedOptionLabels: ["Orchestration-first"],
        },
      }),
    ).toBe(1);
  });

  it("returns the last question index when all answers are complete", () => {
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(questions, {
        scope: {
          selectedOptionLabels: ["Orchestration-first"],
        },
        compat: {
          customAnswer: "Keep it for one release window",
        },
      }),
    ).toBe(1);
  });

  it("derives the active question and advancement state", () => {
    expect(
      derivePendingUserInputProgress(
        questions,
        {
          scope: {
            selectedOptionLabels: ["Orchestration-first"],
          },
        },
        0,
      ),
    ).toMatchObject({
      questionIndex: 0,
      activeQuestion: questions[0],
      selectedOptionLabels: ["Orchestration-first"],
      customAnswer: "",
      resolvedAnswer: "Orchestration-first",
      answeredQuestionCount: 1,
      isLastQuestion: false,
      isComplete: false,
      canAdvance: true,
    });
  });

  it("treats multi-select questions as answered when they have selected options", () => {
    expect(
      derivePendingUserInputProgress(
        [multiSelectQuestion],
        {
          areas: {
            selectedOptionLabels: ["Server", "Web"],
          },
        },
        0,
      ),
    ).toMatchObject({
      selectedOptionLabels: ["Server", "Web"],
      resolvedAnswer: ["Server", "Web"],
      canAdvance: true,
      isComplete: true,
    });
  });
});

describe("decidePendingUserInputAdvance", () => {
  const questions = [
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
  ] as const;

  const advanceFrom = (
    draftAnswers: Parameters<typeof derivePendingUserInputProgress>[1],
    questionIndex: number,
  ) =>
    decidePendingUserInputAdvance(
      derivePendingUserInputProgress(questions, draftAnswers, questionIndex),
    );

  // The defect this pins: Enter reaches the submit path without reading the
  // primary button's disabled state, so it used to walk past a question that
  // had no answer. The prompt then could never be submitted, and nothing on
  // screen said why.
  it("refuses to leave the question on screen without an answer", () => {
    expect(advanceFrom({}, 0)).toEqual({ kind: "blocked" });
  });

  it("moves to the next question once the one on screen is answered", () => {
    expect(advanceFrom({ scope: { selectedOptionLabels: ["Orchestration-first"] } }, 0)).toEqual({
      kind: "go-to-question",
      questionIndex: 1,
    });
  });

  it("submits from the last question once every answer is in", () => {
    expect(
      advanceFrom(
        {
          scope: { selectedOptionLabels: ["Orchestration-first"] },
          compat: { customAnswer: "Keep it for one release window" },
        },
        1,
      ),
    ).toEqual({ kind: "submit" });
  });

  // The recovery path: the last question is answered, an earlier one is not,
  // and the control that used to sit disabled now names that question and
  // goes there.
  it("goes back to the first unanswered question instead of refusing", () => {
    expect(advanceFrom({ compat: { customAnswer: "Keep it for one release window" } }, 1)).toEqual({
      kind: "go-to-question",
      questionIndex: 0,
    });
  });
});

describe("first unanswered question in the derived progress", () => {
  const questions = [
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
  ] as const;

  it("names the question whose answer is missing", () => {
    expect(
      derivePendingUserInputProgress(
        questions,
        { compat: { customAnswer: "Keep it for one release window" } },
        1,
      ).firstUnansweredQuestionIndex,
    ).toBe(0);
  });

  // Distinct from `findFirstUnansweredPendingUserInputQuestionIndex`, which
  // answers "the last one" for a complete set. Null here means there is
  // nowhere to send the user, which is what the submit control reads.
  it("is null once every question is answered", () => {
    expect(
      derivePendingUserInputProgress(
        questions,
        {
          scope: { selectedOptionLabels: ["Orchestration-first"] },
          compat: { customAnswer: "Keep it for one release window" },
        },
        1,
      ).firstUnansweredQuestionIndex,
    ).toBeNull();
  });
});

// Two listeners in two files depend on this answer agreeing with itself: the
// panel acts on the digit, and ChatView's capture-phase handler has to let it
// through instead of typing it into the custom answer.
describe("isPendingUserInputOptionShortcut", () => {
  it("claims a digit that names one of the options", () => {
    expect(isPendingUserInputOptionShortcut(multiSelectQuestion, "2")).toBe(true);
  });

  it("leaves a digit past the last option alone", () => {
    expect(isPendingUserInputOptionShortcut(multiSelectQuestion, "3")).toBe(false);
  });

  it("leaves zero, letters and multi-character keys alone", () => {
    expect(isPendingUserInputOptionShortcut(multiSelectQuestion, "0")).toBe(false);
    expect(isPendingUserInputOptionShortcut(multiSelectQuestion, "a")).toBe(false);
    expect(isPendingUserInputOptionShortcut(multiSelectQuestion, "Enter")).toBe(false);
  });

  it("claims nothing when no question is on screen", () => {
    expect(isPendingUserInputOptionShortcut(null, "1")).toBe(false);
  });
});
