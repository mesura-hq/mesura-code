import { DictationJobId, EnvironmentId, type DictationJob } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { TextFieldSpeechControls, useTextFieldSpeech } from "~/speech/useTextFieldSpeech";
import { claimMicrophone, resetMicrophoneClaimForTest } from "../voice/microphoneClaim";
import { createFakeMedia } from "./dictationMedia.testFixtures";
import * as transport from "./dictationTransport";
import { useFieldDictationStore } from "./fieldDictation";
import { setDictationMediaBackend } from "./recorder";

const jobsFixture = vi.hoisted(() => ({
  jobs: [] as DictationJob[],
  listeners: new Set<() => void>(),
}));

vi.mock("./dictationTransport", () => ({
  uploadDictationAudio: vi.fn(async () => "field-audio-1"),
  startDictationTranscription: vi.fn(async () => ({})),
}));
vi.mock("~/state/dictation", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await importOriginal<typeof import("~/state/dictation")>()),
    useDictationJobs: (environmentId: string | null) => {
      const jobs = useSyncExternalStore(
        (listener) => {
          jobsFixture.listeners.add(listener);
          return () => jobsFixture.listeners.delete(listener);
        },
        () => jobsFixture.jobs,
      );
      return {
        jobs: environmentId === null ? [] : jobs,
        cursor: { epoch: null, revision: null },
        loaded: environmentId !== null,
      };
    },
  };
});

const environmentId = EnvironmentId.make("field-dictation-environment");

function publishJobs(jobs: DictationJob[]) {
  jobsFixture.jobs = jobs;
  for (const listener of jobsFixture.listeners) listener();
}

function setup() {
  const media = createFakeMedia();
  setDictationMediaBackend(media.backend);
  publishJobs([]);
  useFieldDictationStore.setState({
    recording: null,
    pending: {},
    failed: new Set(),
    submitQueued: new Set(),
  });
  resetMicrophoneClaimForTest();
  vi.mocked(transport.startDictationTranscription).mockClear();
  return media;
}

function CommentEditor(props: {
  readonly initial: string;
  readonly onSubmit?: (text: string) => void;
}) {
  const [text, setText] = useState(props.initial);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const speech = useTextFieldSpeech({
    environmentId,
    ownerKey: "field-dictation-comment",
    text,
    textareaRef,
    onTextChange: setText,
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

it("transcribes a recording whose editor closes, and inserts it when the editor opens again", async () => {
  const media = setup();
  {
    await using screen = await render(<CommentEditor initial="Draft" />);
    await screen.getByRole("button", { name: "Start voice dictation" }).click();
    await expect.element(screen.getByRole("button", { name: "Stop and transcribe" })).toBeVisible();
  }
  expect(media.stoppedTracks).toEqual([1]);
  await vi.waitFor(() => expect(transport.startDictationTranscription).toHaveBeenCalledOnce());
  const [, input] = vi.mocked(transport.startDictationTranscription).mock.calls[0]!;
  const job: DictationJob = {
    id: DictationJobId.make(input.jobId),
    target: null,
    mode: "inject",
    status: "completed",
    text: "late words",
    durationMs: 1_000,
    createdAt: "2026-11-18T00:00:00.000Z",
  };
  publishJobs([job]);

  await using reopened = await render(<CommentEditor initial="Draft" />);
  await expect
    .element(reopened.getByRole("textbox", { name: "Comment" }))
    .toHaveValue("Draft late words");
});

const fieldJob = (jobId: string, overrides: Partial<DictationJob> = {}): DictationJob => ({
  id: DictationJobId.make(jobId),
  target: null,
  mode: "inject",
  status: "transcribing",
  durationMs: 1_000,
  createdAt: "2026-11-18T00:00:00.000Z",
  ...overrides,
});

const startedJobIds = () =>
  vi.mocked(transport.startDictationTranscription).mock.calls.map(([, input]) => input.jobId);

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

it("inserts every transcript that landed while the editor was closed", async () => {
  setup();
  {
    await using screen = await render(<CommentEditor initial="Draft" />);
    for (let recording = 0; recording < 2; recording += 1) {
      await screen.getByRole("button", { name: "Start voice dictation" }).click();
      await screen.getByRole("button", { name: "Stop and transcribe" }).click();
      await vi.waitFor(() => expect(startedJobIds()).toHaveLength(recording + 1));
    }
  }
  const [first, second] = startedJobIds();
  publishJobs([
    fieldJob(first!, { status: "completed", text: "one" }),
    fieldJob(second!, { status: "completed", text: "two" }),
  ]);
  await using reopened = await render(<CommentEditor initial="Draft" />);
  await expect
    .element(reopened.getByRole("textbox", { name: "Comment" }))
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
