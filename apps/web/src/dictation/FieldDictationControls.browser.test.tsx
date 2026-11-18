import { DictationJobId, EnvironmentId, type DictationJob } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { TextFieldSpeechControls, useTextFieldSpeech } from "~/speech/useTextFieldSpeech";
import { claimMicrophone } from "../voice/microphoneClaim";
import * as transport from "./dictationTransport";
import { useFieldDictationStore } from "./fieldDictation";
import { fieldJob, setupFieldDictation, startedJobIds } from "./fieldDictation.testFixtures";
import { publishJobs } from "./fieldDictation.testMocks";

vi.mock("./dictationTransport", async () =>
  (await import("./fieldDictation.testMocks")).mockDictationTransportModule(),
);
vi.mock("~/state/dictation", async (importOriginal) =>
  (await import("./fieldDictation.testMocks")).mockDictationJobsModule(importOriginal),
);

const environmentId = EnvironmentId.make("field-dictation-environment");
const setup = setupFieldDictation;

function CommentEditor(props: {
  readonly initial: string;
  readonly onSubmit?: (text: string) => void;
  readonly disabled?: boolean;
}) {
  const [text, setText] = useState(props.initial);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const speech = useTextFieldSpeech({
    environmentId,
    ownerKey: "field-dictation-comment",
    text,
    textareaRef,
    onTextChange: setText,
    disabled: props.disabled,
  });
  return (
    <div>
      <textarea
        ref={textareaRef}
        aria-label="Comment"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <TextFieldSpeechControls speech={speech} />
      <button
        type="button"
        onClick={() => speech.submitAfterDictation((submitted) => props.onSubmit?.(submitted))}
      >
        Submit
      </button>
    </div>
  );
}

it("gives a comment editor one microphone, Mesura's, that inserts the transcript at the caret", async () => {
  const media = setup();
  await using screen = await render(<CommentEditor initial="Looks good merge" />);
  expect(screen.getByRole("button", { name: "Start voice input" }).query()).toBeNull();
  const field = screen.getByRole("textbox", { name: "Comment" });
  await field.click();
  (field.element() as HTMLTextAreaElement).setSelectionRange(10, 10);

  await screen.getByRole("button", { name: "Start voice dictation" }).click();
  await expect.element(screen.getByRole("button", { name: "Stop and transcribe" })).toBeVisible();
  expect(media.recorders).toHaveLength(1);
  await screen.getByRole("button", { name: "Stop and transcribe" }).click();
  await vi.waitFor(() => expect(transport.startDictationTranscription).toHaveBeenCalledOnce());
  const [, input] = vi.mocked(transport.startDictationTranscription).mock.calls[0]!;
  expect(input).toMatchObject({ attachmentId: "field-audio-1", mode: "inject", target: null });
  await expect.element(screen.getByRole("status")).toHaveTextContent("Transcribing…");

  const job: DictationJob = {
    id: DictationJobId.make(input.jobId),
    target: null,
    mode: "inject",
    status: "transcribing",
    durationMs: 1_000,
    createdAt: "2026-11-18T00:00:00.000Z",
  };
  publishJobs([job]);
  publishJobs([{ ...job, status: "completed", text: "after the tests pass" }]);
  await expect.element(field).toHaveValue("Looks good after the tests pass merge");
  expect(screen.getByRole("status").query()).toBeNull();
  expect(media.stoppedTracks).toEqual([1]);
});

it("discards a cancelled recording and frees the microphone", async () => {
  const media = setup();
  await using screen = await render(<CommentEditor initial="" />);
  await screen.getByRole("button", { name: "Start voice dictation" }).click();
  await screen.getByRole("button", { name: "Cancel dictation" }).click();
  await expect
    .element(screen.getByRole("button", { name: "Start voice dictation" }))
    .not.toHaveAttribute("aria-disabled", "true");
  expect(media.stoppedTracks).toEqual([1]);
  expect(transport.startDictationTranscription).not.toHaveBeenCalled();
});

it("transcribes a recording whose editor closes, and keeps it out of the next draft", async () => {
  const media = setup();
  {
    await using screen = await render(<CommentEditor initial="Draft" />);
    await screen.getByRole("button", { name: "Start voice dictation" }).click();
    await expect.element(screen.getByRole("button", { name: "Stop and transcribe" })).toBeVisible();
  }
  expect(media.stoppedTracks).toEqual([1]);
  await vi.waitFor(() => expect(transport.startDictationTranscription).toHaveBeenCalledOnce());
  const [, input] = vi.mocked(transport.startDictationTranscription).mock.calls[0]!;
  expect(useFieldDictationStore.getState().pending).toEqual({});
  publishJobs([
    {
      id: DictationJobId.make(input.jobId),
      target: null,
      mode: "inject",
      status: "completed",
      text: "late words",
      durationMs: 1_000,
      createdAt: "2026-11-18T00:00:00.000Z",
    },
  ]);

  await using reopened = await render(<CommentEditor initial="Draft" />);
  await expect.element(reopened.getByRole("textbox", { name: "Comment" })).toHaveValue("Draft");
});

it("submits a comment only once its Mesura transcript has landed", async () => {
  setup();
  const submitted: string[] = [];
  await using screen = await render(
    <CommentEditor initial="Draft" onSubmit={(text) => submitted.push(text)} />,
  );
  await screen.getByRole("button", { name: "Start voice dictation" }).click();
  await expect.element(screen.getByRole("button", { name: "Stop and transcribe" })).toBeVisible();
  await screen.getByRole("button", { name: "Submit" }).click();
  await vi.waitFor(() => expect(startedJobIds()).toHaveLength(1));
  expect(submitted).toEqual([]);
  await expect.element(screen.getByRole("status")).toHaveTextContent("Sends when transcribed");

  publishJobs([fieldJob(startedJobIds()[0]!, { status: "completed", text: "and ship it" })]);
  await vi.waitFor(() => expect(submitted).toEqual(["Draft and ship it"]));
});

it("does not hold a submission for a transcription that failed", async () => {
  setup();
  const submitted: string[] = [];
  await using screen = await render(
    <CommentEditor initial="Draft" onSubmit={(text) => submitted.push(text)} />,
  );
  await screen.getByRole("button", { name: "Start voice dictation" }).click();
  await screen.getByRole("button", { name: "Stop and transcribe" }).click();
  await vi.waitFor(() => expect(startedJobIds()).toHaveLength(1));
  await screen.getByRole("button", { name: "Submit" }).click();
  publishJobs([fieldJob(startedJobIds()[0]!, { status: "failed", failure: "OpenAI refused" })]);
  await vi.waitFor(() => expect(submitted).toEqual([]));
  await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Submit" }).click();
  expect(submitted).toEqual(["Draft"]);
});

it("inserts transcripts that land together in one update, in recording order", async () => {
  setup();
  await using screen = await render(<CommentEditor initial="Draft" />);
  for (let recording = 0; recording < 2; recording += 1) {
    await screen.getByRole("button", { name: "Start voice dictation" }).click();
    await screen.getByRole("button", { name: "Stop and transcribe" }).click();
    await vi.waitFor(() => expect(startedJobIds()).toHaveLength(recording + 1));
  }
  const [first, second] = startedJobIds();
  publishJobs([
    fieldJob(first!, { status: "completed", text: "one" }),
    fieldJob(second!, { status: "completed", text: "two" }),
  ]);
  await expect
    .element(screen.getByRole("textbox", { name: "Comment" }))
    .toHaveValue("Draft one two");
});

it("discards a microphone granted after its editor closed, and frees the claim", async () => {
  const media = setup();
  {
    await using screen = await render(<CommentEditor initial="" />);
    media.holdMicrophone();
    await screen.getByRole("button", { name: "Start voice dictation" }).click();
  }
  media.releaseMicrophone();
  await vi.waitFor(() => expect(media.stoppedTracks).toEqual([1]));
  expect(useFieldDictationStore.getState().recording).toBeNull();
  const call = claimMicrophone("call");
  expect(call).not.toBeNull();
  call?.();
  expect(transport.startDictationTranscription).not.toHaveBeenCalled();
});

/** Renders an editor whose Submit is held for a recording it stopped; returns the started job. */
async function queueSubmitDuringRecording(
  screen: Awaited<ReturnType<typeof render>>,
): Promise<void> {
  await screen.getByRole("button", { name: "Start voice dictation" }).click();
  await expect.element(screen.getByRole("button", { name: "Stop and transcribe" })).toBeVisible();
  await screen.getByRole("button", { name: "Submit" }).click();
}

it("drops a held submission when the recording cannot be uploaded", async () => {
  setup();
  vi.mocked(transport.uploadDictationAudio).mockRejectedValueOnce(new Error("offline"));
  const submitted: string[] = [];
  await using screen = await render(
    <CommentEditor initial="Draft" onSubmit={(text) => submitted.push(text)} />,
  );
  await queueSubmitDuringRecording(screen);
  await vi.waitFor(() => expect(transport.uploadDictationAudio).toHaveBeenCalledOnce());
  await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Start voice dictation" }))
    .not.toHaveAttribute("aria-disabled", "true");
  expect(useFieldDictationStore.getState().submitQueued.size).toBe(0);
  expect(submitted).toEqual([]);
});

it("does not send while the microphone is still starting", async () => {
  const media = setup();
  const submitted: string[] = [];
  await using screen = await render(
    <CommentEditor initial="Draft" onSubmit={(text) => submitted.push(text)} />,
  );
  media.holdMicrophone();
  await screen.getByRole("button", { name: "Start voice dictation" }).click();
  await expect.element(screen.getByText("Starting…")).toBeVisible();
  await screen.getByRole("button", { name: "Submit" }).click();
  expect(useFieldDictationStore.getState().submitQueued.size).toBe(0);
  await screen.getByRole("button", { name: "Cancel dictation" }).click();
  media.releaseMicrophone();
  await vi.waitFor(() => expect(media.stoppedTracks).toEqual([1]));
  await expect
    .element(screen.getByRole("button", { name: "Start voice dictation" }))
    .not.toHaveAttribute("aria-disabled", "true");
  expect(submitted).toEqual([]);
});

it("drops a held submission when another recording starts, even if that one is cancelled", async () => {
  setup();
  const submitted: string[] = [];
  await using screen = await render(
    <CommentEditor initial="Draft" onSubmit={(text) => submitted.push(text)} />,
  );
  await queueSubmitDuringRecording(screen);
  await vi.waitFor(() => expect(startedJobIds()).toHaveLength(1));
  await screen.getByRole("button", { name: "Start voice dictation" }).click();
  await expect.element(screen.getByRole("button", { name: "Cancel dictation" })).toBeVisible();
  publishJobs([fieldJob(startedJobIds()[0]!, { status: "completed", text: "first" })]);
  await expect.element(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("Draft first");
  await screen.getByRole("button", { name: "Cancel dictation" }).click();
  await expect
    .element(screen.getByRole("button", { name: "Start voice dictation" }))
    .not.toHaveAttribute("aria-disabled", "true");
  expect(submitted).toEqual([]);
});

it("forgets a held submission when its editor closes, so reopening it sends nothing", async () => {
  setup();
  const submitted: string[] = [];
  {
    await using screen = await render(
      <CommentEditor initial="Draft" onSubmit={(text) => submitted.push(text)} />,
    );
    await queueSubmitDuringRecording(screen);
    await vi.waitFor(() => expect(startedJobIds()).toHaveLength(1));
  }
  await using reopened = await render(
    <CommentEditor initial="Reopened" onSubmit={(text) => submitted.push(text)} />,
  );
  publishJobs([fieldJob(startedJobIds()[0]!, { status: "completed", text: "old words" })]);
  const field = reopened.getByRole("textbox", { name: "Comment" });
  await expect.element(field).toHaveValue("Reopened");
  expect(useFieldDictationStore.getState().submitQueued.size).toBe(0);
  expect(submitted).toEqual([]);
});

it("forgets a held submission and its transcript when the editor is disabled", async () => {
  setup();
  const submitted: string[] = [];
  const onSubmit = (text: string) => submitted.push(text);
  await using screen = await render(<CommentEditor initial="Draft" onSubmit={onSubmit} />);
  await queueSubmitDuringRecording(screen);
  await vi.waitFor(() => expect(startedJobIds()).toHaveLength(1));
  await screen.rerender(<CommentEditor initial="Draft" onSubmit={onSubmit} disabled />);
  await vi.waitFor(() => expect(useFieldDictationStore.getState().pending).toEqual({}));
  await screen.rerender(<CommentEditor initial="Draft" onSubmit={onSubmit} />);
  publishJobs([fieldJob(startedJobIds()[0]!, { status: "completed", text: "old words" })]);
  await expect.element(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("Draft");
  expect(submitted).toEqual([]);
});

it("keeps a failed recording's retry out of the draft after a manual submit", async () => {
  setup();
  const submitted: string[] = [];
  await using screen = await render(
    <CommentEditor initial="Draft" onSubmit={(text) => submitted.push(text)} />,
  );
  await screen.getByRole("button", { name: "Start voice dictation" }).click();
  await screen.getByRole("button", { name: "Stop and transcribe" }).click();
  await vi.waitFor(() => expect(startedJobIds()).toHaveLength(1));
  const jobId = startedJobIds()[0]!;
  publishJobs([fieldJob(jobId, { status: "failed", failure: "OpenAI refused" })]);
  await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Submit" }).click();
  expect(submitted).toEqual(["Draft"]);
  publishJobs([fieldJob(jobId, { status: "completed", text: "retried words" })]);
  expect(useFieldDictationStore.getState().pending).toEqual({});
  await expect.element(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("Draft");
});
