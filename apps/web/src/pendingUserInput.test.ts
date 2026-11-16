import { RuntimeRequestId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { formatInlineContextReference } from "./lib/composerContextReferences";
import { threadContextReference } from "./lib/composerContextRecords";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";

import {
  answerContextRecords,
  carryDisplacedCustomAnswerIntoPrompt,
  derivePendingUserInputProgress,
  projectPendingUserInputAnswer,
  threadContextsReferencedByAnswer,
  withdrawDisplacedCustomAnswerFromPrompt,
} from "./pendingUserInput";

describe("projectPendingUserInputAnswer", () => {
  const record = threadContextRecord(
    {
      environmentId: EnvironmentId.make("env-answer"),
      threadId: ThreadId.make("reference-thread"),
    },
    "Reference work",
  );

  it("sends thread chips as readable links with the actual thread ID", () => {
    const answer = `Compare ${formatInlineContextReference(threadContextReference(record))}`;
    expect(projectPendingUserInputAnswer(answer, [record])).toBe(
      "Compare [Reference work](t3-thread://v2/env-answer/reference-thread)",
    );
  });

  // regression: #28022, #36293 review comment and preview annotation chips in an answer reached the agent as bare links
  it("sends thread draft chips with their full content", () => {
    const reviewComment = {
      id: "file-comment-1",
      sectionId: "branch",
      sectionTitle: "Changes",
      filePath: "notes.md",
      startIndex: 2,
      endIndex: 2,
      rangeLabel: "+2",
      text: "Rename this to line two updated",
      diff: "@@ -0,0 +2,1 @@\n+line two changed",
      fenceLanguage: "diff",
    };
    const annotation = {
      id: "annotation-1",
      pageUrl: "http://localhost:3000/",
      pageTitle: "Home",
      comment: "FIRST NOTE: this features section looks too bare; add three feature cards",
      elements: [],
      regions: [],
      strokes: [],
      styleChanges: [],
      screenshot: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const records = answerContextRecords(undefined, {
      reviewComments: [reviewComment],
      previewAnnotations: [annotation],
    });
    const answer = `See my notes: ${records
      .map((record) =>
        formatInlineContextReference({
          kind: record.kind,
          contextId: record.contextId,
          label: record.label,
        }),
      )
      .join(" ")}`;
    const projected = projectPendingUserInputAnswer(answer, records);
    expect(projected).toContain("Rename this to line two updated");
    expect(projected).toContain("+line two changed");
    expect(projected).toContain(`comment: ${annotation.comment}`);
  });

  // regression: #18789 answers to pending questions lost exact text and option values
  it("preserves option values and exact answer text", () => {
    const options = [" first\t", "second"];
    expect(projectPendingUserInputAnswer(options, [record])).toBe(options);
    expect(projectPendingUserInputAnswer("  Edited answer\n", [record])).toBe("  Edited answer\n");
  });
});

describe("threadContextsReferencedByAnswer", () => {
  const kept = threadContextRecord(
    { environmentId: EnvironmentId.make("env-answer"), threadId: ThreadId.make("kept-thread") },
    "Kept work",
  );
  const deleted = threadContextRecord(
    { environmentId: EnvironmentId.make("env-answer"), threadId: ThreadId.make("deleted-thread") },
    "Deleted work",
  );

  it("preserves remaining chips without restoring deleted thread records", () => {
    const answer = `Compare ${formatInlineContextReference(threadContextReference(kept))}`;
    expect(threadContextsReferencedByAnswer(answer, [deleted, kept])).toEqual([kept]);
  });
});

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

  it("counts a deliberately cleared answer as answered", () => {
    const question = { ...singleSelectQuestion, initialAnswer: "  Proposed message\n" };
    const drafts = { scope: { customAnswer: "" } };
    expect(derivePendingUserInputProgress([question], drafts, 0)).toMatchObject({
      customAnswer: "",
      resolvedAnswer: "",
      canAdvance: true,
      isComplete: true,
    });
  });

  it("derives the active question and advancement state", () => {
    expect(
      derivePendingUserInputProgress(
        questions,
        {
          scope: {
            selectedOptionValues: ["Orchestration-first"],
          },
        },
        0,
      ),
    ).toMatchObject({
      questionIndex: 0,
      activeQuestion: questions[0],
      selectedOptionValues: ["Orchestration-first"],
      customAnswer: "",
      resolvedAnswer: "Orchestration-first",
      answeredQuestionCount: 1,
      isLastQuestion: false,
      isComplete: false,
      canAdvance: true,
    });
  });
});

describe("carryDisplacedCustomAnswerIntoPrompt", () => {
  // regression: #12577 clicking a question option discarded typed text
  it("keeps the thread draft when nothing was typed into the answer", () => {
    expect(carryDisplacedCustomAnswerIntoPrompt("draft", undefined)).toBe("draft");
    expect(carryDisplacedCustomAnswerIntoPrompt("draft", "   ")).toBe("draft");
  });

  // regression: #12577 clicking a question option discarded typed text
  it("moves the typed answer into an empty thread draft", () => {
    expect(carryDisplacedCustomAnswerIntoPrompt("", "also rename the flag ")).toBe(
      "also rename the flag",
    );
  });

  it("appends the typed answer after an existing thread draft", () => {
    expect(carryDisplacedCustomAnswerIntoPrompt("first half\n", "second half")).toBe(
      "first half\n\nsecond half",
    );
  });
});

describe("withdrawDisplacedCustomAnswerFromPrompt", () => {
  // regression: #35205 an answer restored with undo stayed in the thread draft and was sent twice
  it("takes set-aside text back out of the thread draft and leaves the rest", () => {
    const setAside = carryDisplacedCustomAnswerIntoPrompt("", "first answer ");
    expect(withdrawDisplacedCustomAnswerFromPrompt(setAside, "first answer ")).toBe("");

    const afterDraft = carryDisplacedCustomAnswerIntoPrompt("draft", "first answer");
    expect(withdrawDisplacedCustomAnswerFromPrompt(afterDraft, "first answer")).toBe("draft");

    const beforeSecond = carryDisplacedCustomAnswerIntoPrompt(setAside, "second answer");
    expect(
      withdrawDisplacedCustomAnswerFromPrompt(beforeSecond, "first answer", ["second answer"]),
    ).toBe("second answer");

    const between = carryDisplacedCustomAnswerIntoPrompt(afterDraft, "second answer");
    expect(
      withdrawDisplacedCustomAnswerFromPrompt(between, "first answer", ["second answer"]),
    ).toBe("draft\n\nsecond answer");
  });

  it("removes its own copy, not equal text inside a later set-aside answer", () => {
    const first = carryDisplacedCustomAnswerIntoPrompt("", "foo");
    const both = carryDisplacedCustomAnswerIntoPrompt(first, "bar\n\nfoo");
    expect(withdrawDisplacedCustomAnswerFromPrompt(both, "foo", ["bar\n\nfoo"])).toBe("bar\n\nfoo");
  });

  it("leaves a thread draft that no longer holds the set-aside text where it was put", () => {
    expect(withdrawDisplacedCustomAnswerFromPrompt("first answer, edited", "first answer")).toBe(
      "first answer, edited",
    );
    expect(withdrawDisplacedCustomAnswerFromPrompt("my first answer", "first answer")).toBe(
      "my first answer",
    );
    expect(withdrawDisplacedCustomAnswerFromPrompt("draft", "  ")).toBe("draft");
  });
});

import {
  buildPendingUserInputAnswers,
  DISMISSED_QUESTION_ANSWER,
  pendingUserInputDismissAction,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "./pendingUserInput";

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
  it("preserves exact editor text, including a deliberately cleared answer", () => {
    const question = { ...singleSelectQuestion, initialAnswer: "  Proposed message\n" };
    expect(resolvePendingUserInputAnswer(question, { customAnswer: question.initialAnswer })).toBe(
      question.initialAnswer,
    );
    expect(resolvePendingUserInputAnswer(question, { customAnswer: "  Edited message\n\n" })).toBe(
      "  Edited message\n\n",
    );
    expect(resolvePendingUserInputAnswer(question, { customAnswer: "" })).toBe("");
    expect(resolvePendingUserInputAnswer(question, { customAnswer: " \n" })).toBe(" \n");
  });

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

describe("inline question dismissal", () => {
  const request = {
    requestId: RuntimeRequestId.make("inline-question"),
    createdAt: "2026-10-24T10:00:00.000Z",
    questions: [singleSelectQuestion, multiSelectQuestion],
    responseCapability: "live" as const,
    dismissible: false,
  };

  it("uses the existing dismiss operation for a dismissible request", () => {
    expect(pendingUserInputDismissAction({ ...request, dismissible: true })).toEqual({
      type: "dismiss",
      requestId: request.requestId,
    });
  });

  it("answers every question as dismissed when the provider cannot dismiss it", () => {
    expect(pendingUserInputDismissAction(request)).toEqual({
      type: "respond",
      requestId: request.requestId,
      answers: { scope: DISMISSED_QUESTION_ANSWER, areas: DISMISSED_QUESTION_ANSWER },
    });
    expect(DISMISSED_QUESTION_ANSWER).toBe(
      "[dismissed] The developer dismissed this question without answering. Continue without this answer, or ask again in plain text.",
    );
  });
});
