import { expect, it } from "vite-plus/test";

import { toOpenCodeQuestionAnswers } from "./opencodeRuntime.ts";

it("OpenCode keeps option and note as native QuestionAnswer values", () => {
  const request = {
    id: "request-1",
    sessionID: "session-1",
    questions: [
      {
        header: "Scope",
        question: "Which scope?",
        options: [
          { label: "Workspace", description: "Current workspace" },
          { label: "Session", description: "Current session" },
        ],
        multiple: true,
        custom: true,
      },
    ],
  };

  expect(
    toOpenCodeQuestionAnswers(request, {
      "question-0-scope": ["Workspace", "Session", "Keep both active"],
    }),
  ).toEqual([["Workspace", "Session", "Keep both active"]]);
});
