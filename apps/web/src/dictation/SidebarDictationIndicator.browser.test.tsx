/**
 * The sidebar's recording mark, over the real controller. The boundaries are the RPC commands
 * (`runAtomCommand`), the upload cycle and the microphone; the draft store, the send-when-ready
 * store and the ownership records are real.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DictationJobId, EnvironmentId, ThreadId, type DictationMode } from "@t3tools/contracts";
import { findDictationSlots } from "@t3tools/shared/dictationSlots";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  names: new Map<unknown, string>(),
  calls: [] as Array<{ name: string; value: unknown }>,
}));

vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: async (_registry: unknown, command: unknown, value: unknown) => {
    const name = fixture.names.get(command) ?? "other";
    fixture.calls.push({ name, value });
    if (name !== "start") return { _tag: "Success", value: undefined };
    const { input } = value as { input: { jobId: string } };
    return { _tag: "Success", value: { id: input.jobId, epoch: "server-run-1", revision: 1 } };
  },
}));
vi.mock("@t3tools/client-runtime/state/attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/attachments")>()),
  runAttachmentUploadCycle: async () => ({ status: "uploaded", attachmentId: "dictation-audio" }),
}));

import { render } from "../../test/render";
import { useComposerDraftStore } from "~/composerDraftStore";
import { dictationEnvironment } from "~/state/dictation";
import {
  cancelDictation,
  deliverDictationJobs,
  registerDictationComposer,
  selectDictationMode,
  startDictation,
} from "./dictationController";
import { createFakeMedia } from "./dictationMedia.testFixtures";
import { useDictationSessionStore } from "./dictationSessionStore";
import { setDictationMediaBackend } from "./recorder";
import { sendWhenReadyKey, useSendWhenReadyStore } from "./sendWhenReady";
import { SidebarDictationIndicator } from "./SidebarDictationIndicator";

const environmentId = EnvironmentId.make("sidebar-dictation-environment");
const recordingThreadId = ThreadId.make("sidebar-dictation-recording-thread");
const otherThreadId = ThreadId.make("sidebar-dictation-other-thread");
const recordingThread = scopeThreadRef(environmentId, recordingThreadId);
const otherThread = scopeThreadRef(environmentId, otherThreadId);

function showThreadComposer(threadId: ThreadId) {
  return registerDictationComposer({
    environmentId,
    target: { kind: "thread", environmentId, threadId },
    draftTarget: scopeThreadRef(environmentId, threadId),
    insertSlot: null,
  });
}

/** Starts recording in the first thread, then opens the other one, as the user does. */
async function setup(mode: DictationMode) {
  fixture.calls.length = 0;
  fixture.names = new Map<unknown, string>([[dictationEnvironment.start, "start"]]);
  setDictationMediaBackend(createFakeMedia().backend);
  useComposerDraftStore.getState().setPrompt(recordingThread, "Draft");
  const releaseRecordingThread = showThreadComposer(recordingThreadId);
  await startDictation();
  selectDictationMode(mode);
  releaseRecordingThread();
  const releaseOtherThread = showThreadComposer(otherThreadId);
  return {
    [Symbol.dispose]() {
      cancelDictation();
      releaseOtherThread();
      useDictationSessionStore.setState({ session: null, lastJob: null });
      useComposerDraftStore.getState().clearComposerContent(recordingThread);
      useComposerDraftStore.getState().clearComposerContent(otherThread);
      useSendWhenReadyStore.setState({ drafts: {}, questions: {} });
      setDictationMediaBackend(null);
    },
  };
}

const rows = () => (
  <>
    <div data-testid="recording-thread-row">
      <SidebarDictationIndicator threadRef={recordingThread} />
    </div>
    <div data-testid="other-thread-row">
      <SidebarDictationIndicator threadRef={otherThread} />
    </div>
  </>
);

const startCall = () =>
  fixture.calls.find((call) => call.name === "start")?.value as
    | { input: { jobId: string; mode: DictationMode; target: unknown } }
    | undefined;

const markers = () =>
  findDictationSlots(
    useComposerDraftStore.getState().getComposerDraft(recordingThread)?.prompt ?? "",
  ).map((slot) => slot.jobId);

describe("the sidebar's recording mark", () => {
  it("marks only the recording's thread, and one tap stops it into that thread in insert mode", async () => {
    using _setup = await setup("inject");
    await using screen = await render(rows());

    const stop = screen.getByRole("button", {
      name: "Stop recording and insert it in this thread",
    });
    await expect.element(stop).toBeInTheDocument();
    expect(screen.getByTestId("other-thread-row").element().childElementCount).toBe(0);

    await userEvent.click(stop);
    await vi.waitFor(() => expect(startCall()).toBeDefined());
    const { input } = startCall()!;
    expect(input.mode).toBe("inject");
    expect(input.target).toEqual({ kind: "thread", environmentId, threadId: recordingThreadId });
    expect(markers()).toEqual([input.jobId]);
    expect(useComposerDraftStore.getState().getComposerDraft(otherThread)?.prompt ?? "").toBe("");

    // The transcription is on its way: the mark stays, and is no longer a stop button.
    await expect.element(screen.getByRole("img", { name: "Transcribing dictation" })).toBeVisible();
    expect(screen.getByTestId("other-thread-row").element().childElementCount).toBe(0);

    deliverDictationJobs(environmentId, [
      {
        id: DictationJobId.make(input.jobId),
        target: { kind: "thread", environmentId, threadId: recordingThreadId },
        mode: "inject",
        status: "completed",
        text: "hola",
        durationMs: 1_000,
        createdAt: "2026-10-26T12:00:00.000Z",
      },
    ]);
    await vi.waitFor(() =>
      expect(screen.getByTestId("recording-thread-row").element().childElementCount).toBe(0),
    );
  });

  it("one tap in send mode stops it and arms that thread's draft to send", async () => {
    using _setup = await setup("submit");
    await using screen = await render(rows());

    await userEvent.click(
      screen.getByRole("button", { name: "Stop recording and send it in this thread" }),
    );
    await vi.waitFor(() => expect(startCall()?.input.mode).toBe("submit"));
    const drafts = useSendWhenReadyStore.getState().drafts;
    expect(drafts[sendWhenReadyKey(recordingThread)]?.armed).toBe(true);
    expect(drafts[sendWhenReadyKey(otherThread)]?.armed ?? false).toBe(false);
  });

  it("goes away when the recording is cancelled", async () => {
    using _setup = await setup("inject");
    await using screen = await render(rows());

    await expect
      .element(screen.getByRole("button", { name: /^Stop recording/ }))
      .toBeInTheDocument();
    cancelDictation();
    await vi.waitFor(() =>
      expect(screen.getByTestId("recording-thread-row").element().childElementCount).toBe(0),
    );
  });
});
