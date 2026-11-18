import {
  EnvironmentId,
  ProjectId,
  type PullRequestDetailView,
  type PullRequestRef,
} from "@t3tools/contracts";
import { createRef } from "react";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import * as transport from "~/dictation/dictationTransport";
import { useFieldDictationStore } from "~/dictation/fieldDictation";
import {
  fieldJob,
  setupFieldDictation,
  startedJobIds,
} from "~/dictation/fieldDictation.testFixtures";
import { publishJobs } from "~/dictation/fieldDictation.testMocks";
import { PullRequestCommentForm } from "./PullRequestCommentForm";

vi.mock("~/dictation/dictationTransport", async () =>
  (await import("~/dictation/fieldDictation.testMocks")).mockDictationTransportModule(),
);
vi.mock("~/state/dictation", async (importOriginal) =>
  (await import("~/dictation/fieldDictation.testMocks")).mockDictationJobsModule(importOriginal),
);
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(async () => ({ _tag: "Success" })),
}));

const reference: PullRequestRef = {
  projectId: ProjectId.make("pr-comment-project"),
  repository: "test/repo",
  number: 7,
};
const detail = {
  state: "open",
  provider: "github",
  capabilities: { actions: ["close"] },
  viewerPermissions: { actions: ["close"] },
} as unknown as PullRequestDetailView;

function renderForm(props: {
  readonly active?: boolean;
  readonly onCommentAction: (
    body: string,
    action: "close" | "reopen",
  ) => Promise<{
    readonly commentPosted: boolean;
  }>;
}) {
  return (
    <PullRequestCommentForm
      environmentId={EnvironmentId.make("pr-comment-environment")}
      active={props.active ?? true}
      reference={reference}
      detail={detail}
      actionPending={false}
      textareaRef={createRef()}
      onCommentAction={props.onCommentAction}
      onCommented={vi.fn()}
      onClose={vi.fn()}
    />
  );
}

/** Types a prefix, records, and confirms Close with comment while the recording runs. */
async function closeWhileRecording(screen: Awaited<ReturnType<typeof render>>) {
  await screen.getByRole("textbox").fill("Typed prefix");
  await screen.getByRole("button", { name: "Start voice dictation" }).click();
  await expect.element(screen.getByRole("button", { name: "Stop and transcribe" })).toBeVisible();
  await screen.getByRole("button", { name: /Close with comment/ }).click();
  await screen.getByRole("button", { name: /Confirm close\?/ }).click();
}

it("closes with the whole comment once its transcript lands", async () => {
  setupFieldDictation();
  const onCommentAction = vi.fn(async () => ({ commentPosted: true }));
  await using screen = await render(renderForm({ onCommentAction }));
  await closeWhileRecording(screen);
  await vi.waitFor(() => expect(startedJobIds()).toHaveLength(1));
  expect(onCommentAction).not.toHaveBeenCalled();
  publishJobs([fieldJob(startedJobIds()[0]!, { status: "completed", text: "and the rest" })]);
  await vi.waitFor(() =>
    expect(onCommentAction).toHaveBeenCalledWith("Typed prefix and the rest", "close"),
  );
});

it("neither posts the typed prefix nor closes the pull request when the upload fails", async () => {
  setupFieldDictation();
  vi.mocked(transport.uploadDictationAudio).mockRejectedValueOnce(new Error("offline"));
  const onCommentAction = vi.fn(async () => ({ commentPosted: true }));
  await using screen = await render(renderForm({ onCommentAction }));
  await closeWhileRecording(screen);
  await vi.waitFor(() => expect(transport.uploadDictationAudio).toHaveBeenCalledOnce());
  await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Start voice dictation" }))
    .not.toHaveAttribute("aria-disabled", "true");
  expect(onCommentAction).not.toHaveBeenCalled();
});

it("forgets the close when the form is hidden, and keeps the transcript in its draft", async () => {
  setupFieldDictation();
  const onCommentAction = vi.fn(async () => ({ commentPosted: true }));
  await using screen = await render(renderForm({ onCommentAction }));
  await closeWhileRecording(screen);
  await vi.waitFor(() => expect(startedJobIds()).toHaveLength(1));
  await screen.rerender(renderForm({ onCommentAction, active: false }));
  await vi.waitFor(() => expect(useFieldDictationStore.getState().submitQueued.size).toBe(0));
  await screen.rerender(renderForm({ onCommentAction }));
  publishJobs([fieldJob(startedJobIds()[0]!, { status: "completed", text: "late" })]);
  await expect.element(screen.getByRole("textbox")).toHaveValue("Typed prefix late");
  expect(onCommentAction).not.toHaveBeenCalled();
});

it("fills the comment from a transcription retry after its close failed to post", async () => {
  setupFieldDictation();
  const onCommentAction = vi.fn(async () => ({ commentPosted: false }));
  await using screen = await render(renderForm({ onCommentAction }));
  await screen.getByRole("textbox").fill("Typed prefix");
  await screen.getByRole("button", { name: "Start voice dictation" }).click();
  await screen.getByRole("button", { name: "Stop and transcribe" }).click();
  await vi.waitFor(() => expect(startedJobIds()).toHaveLength(1));
  const jobId = startedJobIds()[0]!;
  publishJobs([fieldJob(jobId, { status: "failed", failure: "OpenAI refused" })]);
  await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
  await screen.getByRole("button", { name: /Close with comment/ }).click();
  await screen.getByRole("button", { name: /Confirm close\?/ }).click();
  await vi.waitFor(() => expect(onCommentAction).toHaveBeenCalledWith("Typed prefix", "close"));
  await expect.element(screen.getByRole("button", { name: /Close with comment/ })).toBeEnabled();
  publishJobs([fieldJob(jobId, { status: "completed", text: "retried" })]);
  await expect.element(screen.getByRole("textbox")).toHaveValue("Typed prefix retried");
});
