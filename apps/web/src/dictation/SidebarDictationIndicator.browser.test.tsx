/**
 * The sidebar's recording mark, over the real controller. The boundaries are the RPC commands
 * (`runAtomCommand`), the upload cycle and the microphone; the draft store, the send-when-ready
 * store and the ownership records are real.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DictationJobId,
  EnvironmentId,
  ThreadId,
  ProviderDriverKind,
  type DictationMode,
} from "@t3tools/contracts";
import { findDictationSlots } from "@t3tools/shared/dictationSlots";
import { cdp, page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

const commitCounter = await vi.hoisted(async () =>
  (await import("../test/reactCommitCounter")).installReactCommitCounter(),
);

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

import { act, render } from "../../test/render";
import { UnsortableThreadRow } from "~/components/sidebar/SidebarThreadRow";
import { makeThreadFixture } from "~/test-fixtures";
import "~/index.css";
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
import { useDictationWidgetActivityStore } from "./dictationWidgetState";
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
      useDictationWidgetActivityStore.setState({ transcribing: {}, unlisted: {} });
      setDictationMediaBackend(null);
    },
  };
}

const rows = () => (
  <>
    <div
      data-testid="recording-thread-row"
      onClick={() => fixture.calls.push({ name: "row-click", value: null })}
      onDoubleClick={() => fixture.calls.push({ name: "row-double-click", value: null })}
    >
      <SidebarDictationIndicator threadRef={recordingThread} />
    </div>
    <div data-testid="other-thread-row">
      <SidebarDictationIndicator threadRef={otherThread} />
    </div>
  </>
);

const LONG_TITLE =
  "Keep the complete sidebar title readable while recording dictation and reviewing a very long thread";

function threadRow(variant: "card" | "slim", width = 280) {
  const thread = makeThreadFixture({
    environmentId,
    id: recordingThreadId,
    title: LONG_TITLE,
    branch: "mesura/sidebar-dictation-wave",
  });
  return (
    <ul className="dark bg-sidebar text-foreground p-2" style={{ width }}>
      <UnsortableThreadRow
        thread={thread}
        variant={variant}
        variantAction="settle"
        sortableId="dictation-row"
        sortableDisabled
        contextDrag={false}
        settlementSupported
        snoozeSupported
        pinningSupported={false}
        isPinned={false}
        dropVerb={null}
        dragOverPinned={false}
        sweepAction={null}
        snoozeWakeLabelText={null}
        wokeAt={null}
        isActive
        isRouteThread
        openPullRequestsInRightPanel={false}
        jumpLabel={null}
        currentEnvironmentId={environmentId}
        environmentLabel="Desktop"
        environmentMachine="desktop"
        scratchMachineLabel={null}
        project={null}
        projectDisplayName="Mesura Code"
        providerEntryByInstanceId={
          new Map([
            [
              "codex",
              {
                instanceId: thread.modelSelection.instanceId,
                driverKind: ProviderDriverKind.make("codex"),
                enabled: true,
                displayName: "Codex",
                models: [],
              },
            ],
          ])
        }
        timestampFormat="locale"
        onThreadClick={() => {}}
        onThreadActivate={() => {}}
        onStartRename={() => {}}
        onRenameTitleChange={() => {}}
        onCommitRename={() => {}}
        onCancelRename={() => {}}
        isRenaming={false}
        renamingTitle=""
        onContextMenu={() => {}}
        onSettle={() => {}}
        onActionSweepStart={() => {}}
        onUnsettle={() => {}}
        onSnooze={() => {}}
        onUnsnooze={() => {}}
        onUnpin={() => {}}
        onAcknowledgeWoke={() => {}}
      />
    </ul>
  );
}

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
    expect(stop.element().classList.contains("text-foreground")).toBe(true);
    expect(stop.element().className).not.toContain("destructive");
    expect(screen.getByTestId("other-thread-row").element().childElementCount).toBe(0);

    stop.element().dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await userEvent.click(stop);
    expect(fixture.calls.some(({ name }) => name.startsWith("row-"))).toBe(false);
    await vi.waitFor(() => expect(startCall()).toBeDefined());
    const { input } = startCall()!;
    expect(input.mode).toBe("inject");
    expect(input.target).toEqual({ kind: "thread", environmentId, threadId: recordingThreadId });
    expect(markers()).toEqual([input.jobId]);
    expect(useComposerDraftStore.getState().getComposerDraft(otherThread)?.prompt ?? "").toBe("");

    // The transcription is on its way: the mark stays, and is no longer a stop button.
    const transcribing = screen.getByRole("img", { name: "Transcribing dictation" });
    await expect.element(transcribing).toBeVisible();
    expect(transcribing.element().classList.contains("text-foreground")).toBe(true);
    expect(transcribing.element().className).not.toContain("destructive");
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

  it.each([
    ["card", 280],
    ["card", 412],
    ["slim", 280],
    ["slim", 412],
  ] as const)(
    "keeps the %s row title before the waveform and outside the controls at %s px",
    async (variant, width) => {
      using _setup = await setup("inject");
      await using screen = await render(threadRow(variant, width));
      const stop = screen.getByRole("button", { name: /^Stop recording/ });
      await expect.element(stop).toBeVisible();
      const title = screen.container.querySelector<HTMLElement>("span[dir]")!;
      const indicator = stop.element();
      expect(
        title.compareDocumentPosition(indicator) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(title.scrollWidth).toBeGreaterThan(title.clientWidth);
      const titleBounds = title.getBoundingClientRect();
      const indicatorBounds = indicator.getBoundingClientRect();
      expect(titleBounds.right).toBeLessThanOrEqual(indicatorBounds.left);
      expect(
        Math.abs(
          titleBounds.top +
            titleBounds.height / 2 -
            indicatorBounds.top -
            indicatorBounds.height / 2,
        ),
      ).toBeLessThan(1);
      await userEvent.hover(screen.getByTestId(`sidebar-row-${variant}`));
      const settle = screen.getByRole("button", { name: "Settle thread" });
      await expect.element(settle).toBeVisible();
      const controlBounds = settle.element().getBoundingClientRect();
      const bounds = indicator.getBoundingClientRect();
      expect(
        bounds.right <= controlBounds.left ||
          bounds.top >= controlBounds.bottom ||
          bounds.bottom <= controlBounds.top,
      ).toBe(true);
    },
  );

  it("updates microphone bars without re-rendering the sidebar row or indicator", async () => {
    using _setup = await setup("inject");
    commitCounter.start();
    await using screen = await render(threadRow("card"));
    await expect.element(screen.getByRole("button", { name: /^Stop recording/ })).toBeVisible();
    expect(commitCounter.stop().some(({ name }) => name === "SidebarThreadRow")).toBe(true);
    commitCounter.start();
    await act(() => {
      for (const level of [0.2, 0.8, 0.4, 0.1]) {
        const session = useDictationSessionStore.getState().session!;
        useDictationSessionStore.setState({ session: { ...session, level } });
      }
    });
    expect(
      commitCounter
        .stop()
        .filter(({ name }) => name === "SidebarThreadRow" || name === "SidebarDictationIndicator"),
    ).toEqual([]);
  });

  it.each(["card", "slim"] as const)(
    "keeps the %s recording target usable across 44 px on touch",
    async (variant) => {
      using _setup = await setup("inject");
      await page.viewport(412, 915);
      await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
      try {
        await using screen = await render(threadRow(variant, 412));
        const stop = screen.getByRole("button", { name: /^Stop recording/ });
        await expect.element(stop).toBeVisible();
        await vi.waitFor(() => expect(window.matchMedia("(pointer: coarse)").matches).toBe(true));
        const button = stop.element();
        expect(button.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
        expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
        await vi.waitFor(() => {
          const bounds = button.getBoundingClientRect();
          for (const [dx, dy] of [
            [-21, -21],
            [-21, 21],
            [21, -21],
            [21, 21],
          ] as const) {
            const hit = document.elementFromPoint(
              bounds.left + bounds.width / 2 + dx,
              bounds.top + bounds.height / 2 + dy,
            );
            expect(button.contains(hit)).toBe(true);
          }
        });
      } finally {
        await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
        await page.viewport(1280, 900);
      }
    },
  );
});
