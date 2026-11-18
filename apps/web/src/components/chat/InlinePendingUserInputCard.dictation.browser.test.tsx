import { DictationJobId, EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import {
  fillDictationSlot,
  formatDictationSlot,
  removeDictationSlot,
} from "@t3tools/shared/dictationSlots";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import * as dictationController from "../../dictation/dictationController";
import { composerEditorElement, resolveKeyScope } from "../../keys/focusScope";
import {
  editPendingUserInputAnswerText,
  pendingUserInputRequestKey,
  readPendingUserInputAnswerText,
  usePendingUserInputDraftStore,
} from "../../pendingUserInputDraftStore";
import type { PendingUserInput } from "../../session-logic";
import { InlinePendingUserInputCard } from "./InlinePendingUserInputCard";

vi.mock("../../dictation/dictationController", { spy: true });

const environmentId = EnvironmentId.make("card-dictation-environment");
const threadId = ThreadId.make("card-dictation-thread");
const requestId = RuntimeRequestId.make("card-dictation-request");
const key = pendingUserInputRequestKey(environmentId, threadId, requestId);
const jobId = DictationJobId.make("job-card-1");
const marker = formatDictationSlot(jobId);

const request: PendingUserInput = {
  requestId,
  createdAt: "2026-11-18T00:00:00.000Z",
  dismissible: true,
  responseCapability: "message",
  questions: [
    {
      id: "detail",
      header: "Detail",
      question: "Anything to add?",
      multiSelect: false,
      options: [{ label: "Yes", description: "" }],
    },
  ],
};

function setup() {
  usePendingUserInputDraftStore.setState({ requests: {} });
  vi.mocked(dictationController.registerDictationComposer).mockClear();
}

function renderCard() {
  return render(
    <InlinePendingUserInputCard
      request={request}
      context={{
        environmentId,
        threadId,
        requests: [request],
        supportsAttachments: false,
        maxFileBytes: null,
        unavailable: false,
        respondingRequestIds: [],
        onRespond: async () => false,
        onDismiss: async () => false,
        onDismissWithAnswer: async () => false,
      }}
    />,
  );
}

const editAnswer = (edit: (text: string) => string | null) =>
  editPendingUserInputAnswerText(key, "detail", edit);

it("draws a dictation marker in an answer as the transcribing chip, not as its link", async () => {
  setup();
  await using screen = await renderCard();
  editAnswer(() => `Before ${marker} after`);
  const field = screen.getByRole("textbox", { name: "Anything to add?" });
  await expect.element(field.getByRole("img", { name: "Transcribing" })).toBeInTheDocument();
  const text = field.element().textContent ?? "";
  expect(text).toMatch(/Before.*after/);
  expect(text).not.toContain("t3-context");
});

it("draws the chip at a phone's width too", async () => {
  setup();
  await page.viewport(412, 915);
  await using screen = await renderCard();
  editAnswer(() => marker);
  const field = screen.getByRole("textbox", { name: "Anything to add?" });
  await expect.element(field.getByRole("img", { name: "Transcribing" })).toBeInTheDocument();
  expect(field.element().textContent).not.toContain("t3-context");
});

it("replaces the chip with the transcript, and a removed marker leaves the typed text", async () => {
  setup();
  await using screen = await renderCard();
  editAnswer(() => `Start ${marker} end`);
  const field = screen.getByRole("textbox", { name: "Anything to add?" });
  await expect.element(field.getByRole("img", { name: "Transcribing" })).toBeInTheDocument();
  editAnswer((text) => {
    const result = fillDictationSlot(text, jobId, "spoken words");
    return "missing" in result ? null : result.text;
  });
  await expect.element(field).toHaveTextContent("Start spoken words end");
  expect(field.getByRole("img", { name: "Transcribing" }).query()).toBeNull();

  const second = DictationJobId.make("job-card-2");
  editAnswer((text) => `${text} ${formatDictationSlot(second)}`);
  await expect.element(field.getByRole("img", { name: "Transcribing" })).toBeInTheDocument();
  editAnswer((text) => {
    const result = removeDictationSlot(text, second);
    return "missing" in result ? null : result.text;
  });
  await expect.element(field).toHaveTextContent("Start spoken words end");
  expect(field.getByRole("img", { name: "Transcribing" }).query()).toBeNull();
});

it("drops a stopped recording's marker at the answer's caret", async () => {
  setup();
  await using screen = await renderCard();
  const field = screen.getByRole("textbox", { name: "Anything to add?" });
  await field.click();
  await userEvent.keyboard("helloworld");
  await userEvent.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}");
  const registered = vi.mocked(dictationController.registerDictationComposer).mock.calls.at(-1);
  expect(registered).toBeDefined();
  expect(registered![0].insertSlot?.(marker)).toBe(true);
  expect(readPendingUserInputAnswerText(key, "detail")).toBe(`hello ${marker} world`);
  await expect.element(field.getByRole("img", { name: "Transcribing" })).toBeInTheDocument();
});

it("keeps the answer editor out of the composer's keys", async () => {
  setup();
  await using screen = await renderCard();
  const field = screen.getByRole("textbox", { name: "Anything to add?" });
  await field.click();
  // The composer's send and Vim keys act on `composerEditorElement()`, never on an answer.
  expect(resolveKeyScope()).toBe("insert");
  expect(composerEditorElement()).toBeNull();
});

it("keeps an answer literal around its markers, inside display math and brackets", async () => {
  setup();
  await using screen = await renderCard();
  const second = formatDictationSlot(DictationJobId.make("job-card-math"));
  editAnswer(() => `\\[ x ${marker} y \\] and [draft notes ${second}] @README.md`);
  const field = screen.getByRole("textbox", { name: "Anything to add?" });
  await vi.waitFor(() =>
    expect(field.getByRole("img", { name: "Transcribing" }).elements()).toHaveLength(2),
  );
  const text = field.element().textContent ?? "";
  expect(text).not.toContain("t3-context");
  expect(text).toContain("\\[ x");
  expect(text).toContain("[draft notes");
  expect(text).toContain("@README.md");
});

it("focuses the answer from its label", async () => {
  setup();
  await using screen = await renderCard();
  await screen.getByText("Additional detail").click();
  await expect.element(screen.getByRole("textbox", { name: "Anything to add?" })).toHaveFocus();
});
