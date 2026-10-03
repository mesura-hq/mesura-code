// @vitest-environment happy-dom
/**
 * Regression tests for the dictation controller, from the phase 4 review. The boundaries are the
 * RPC commands (`runAtomCommand`), the upload cycle and the microphone; the draft store and the
 * ownership records are real.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DictationJobId,
  EnvironmentId,
  ThreadId,
  type DictationJob,
  type DictationMode,
} from "@t3tools/contracts";
import { findDictationSlots } from "@t3tools/shared/dictationSlots";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  names: new Map<unknown, string>(),
  calls: [] as Array<{ name: string; value: unknown }>,
  /** While set, the start command waits for it. */
  startGate: null as Promise<void> | null,
}));

vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: async (_registry: unknown, command: unknown, value: unknown) => {
    const name = fixture.names.get(command) ?? "other";
    fixture.calls.push({ name, value });
    if (name === "start" && fixture.startGate) await fixture.startGate;
    return { _tag: "Success", value: undefined };
  },
}));
vi.mock("@t3tools/client-runtime/state/attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/attachments")>()),
  runAttachmentUploadCycle: async () => ({ status: "uploaded", attachmentId: "dictation-audio" }),
}));

import { toastManager } from "~/components/ui/toast";
import { persistComposerDrafts, useComposerDraftStore } from "~/composerDraftStore";
import { dictationEnvironment } from "~/state/dictation";
import {
  cancelDictation,
  deliverDictationJobs,
  registerDictationComposer,
  restartDictation,
  selectDictationMode,
  startDictation,
  stopDictation,
} from "./dictationController";
import { createFakeMedia } from "./dictationMedia.testFixtures";
import {
  createOwnDictationJobs,
  isDictationLive,
  recordOwnDictationJob,
  updateOwnDictationJob,
  useDictationSessionStore,
  useOwnDictationJobsStore,
} from "./dictationSessionStore";
import { setDictationMediaBackend } from "./recorder";
import { withDictatedPrefix } from "./sendWhenReady";

const environmentId = EnvironmentId.make("dictation-controller-environment");
const threadId = ThreadId.make("dictation-controller-thread");
const draftTarget = scopeThreadRef(environmentId, threadId);
let media: ReturnType<typeof createFakeMedia>;
let unregister: () => void;
let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

beforeEach(() => {
  fixture.calls.length = 0;
  fixture.startGate = null;
  fixture.names = new Map<unknown, string>([
    [dictationEnvironment.start, "start"],
    [dictationEnvironment.setMode, "setMode"],
  ]);
  media = createFakeMedia();
  setDictationMediaBackend(media.backend);
  writeText = vi.fn(async (_text: string) => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  vi.spyOn(toastManager, "add");
  useComposerDraftStore.getState().setPrompt(draftTarget, "Draft");
  unregister = registerDictationComposer({
    environmentId,
    target: { kind: "thread", environmentId, threadId },
    draftTarget,
    insertSlot: null,
  });
});

afterEach(() => {
  cancelDictation();
  unregister();
  useDictationSessionStore.setState({ session: null, lastJob: null });
  useComposerDraftStore.getState().clearComposerContent(draftTarget);
  setDictationMediaBackend(null);
  Reflect.deleteProperty(navigator, "clipboard");
  vi.restoreAllMocks();
});

const prompt = () => useComposerDraftStore.getState().getComposerDraft(draftTarget)?.prompt ?? "";
const markers = () => findDictationSlots(prompt()).map((slot) => slot.jobId);
const callsNamed = (name: string) =>
  fixture.calls.filter((call) => call.name === name).map((call) => call.value);
const lastJobId = () => useDictationSessionStore.getState().lastJob!.jobId;

async function recordAndStop(mode?: DictationMode): Promise<DictationJobId> {
  await startDictation();
  if (mode) selectDictationMode(mode);
  await stopDictation();
  return lastJobId();
}

function completed(jobId: string, mode: DictationMode, text: string): DictationJob {
  return {
    id: DictationJobId.make(jobId),
    target: { kind: "thread", environmentId, threadId },
    mode,
    status: "completed",
    text,
    durationMs: 1_000,
    createdAt: "2026-10-03T12:00:00.000Z",
  };
}

/** Lets the async delivery (clipboard writes) finish. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("dictation mode changes after the recording stopped", () => {
  it("dictation phase 4 regression: a saved job switched to insert drops a marker and fills it", async () => {
    const jobId = await recordAndStop("clipboard");
    expect(markers()).toEqual([]);
    expect(callsNamed("start")[0]).toMatchObject({ input: { mode: "clipboard", target: null } });

    selectDictationMode("inject");
    expect(markers()).toEqual([jobId]);
    expect(callsNamed("setMode")).toEqual([{ environmentId, input: { jobId, mode: "inject" } }]);

    deliverDictationJobs(environmentId, [completed(jobId, "inject", "ahora en el borrador")]);
    await settle();
    expect(prompt()).toBe("Draft ahora en el borrador");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("dictation phase 4 regression: an inserting job switched to save takes its marker out and copies", async () => {
    const jobId = await recordAndStop();
    expect(markers()).toEqual([jobId]);

    selectDictationMode("clipboard");
    expect(markers()).toEqual([]);
    expect(prompt()).toBe("Draft");

    deliverDictationJobs(environmentId, [completed(jobId, "clipboard", "al portapapeles")]);
    await settle();
    expect(writeText).toHaveBeenCalledExactlyOnceWith("al portapapeles");
    expect(prompt()).toBe("Draft");
  });

  it("dictation phase 4 regression: a mode key pressed while the start is on the wire reaches the server", async () => {
    let openGate = () => undefined as void;
    fixture.startGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    await startDictation();
    const stopping = stopDictation();
    await vi.waitFor(() => expect(callsNamed("start")).toHaveLength(1));
    const jobId = lastJobId();

    selectDictationMode("clipboard");
    expect(callsNamed("setMode")).toEqual([]);
    openGate();
    await stopping;
    expect(callsNamed("start")[0]).toMatchObject({ input: { mode: "submit" } });
    expect(callsNamed("setMode")).toEqual([{ environmentId, input: { jobId, mode: "clipboard" } }]);
  });
});

describe("dictation across reloads and tabs", () => {
  it("dictation phase 4 regression: after a reload the mode keys pick the transcribing job back up", async () => {
    const jobId = await recordAndStop();
    fixture.calls.length = 0;

    vi.resetModules();
    const reloaded = await import("./dictationController");
    const reloadedStore = await import("./dictationSessionStore");
    const reloadedCommands = (await import("~/state/dictation")).dictationEnvironment;
    fixture.names.set(reloadedCommands.start, "start");
    fixture.names.set(reloadedCommands.setMode, "setMode");
    expect(reloadedStore.isDictationLive()).toBe(false);

    reloaded.deliverDictationJobs(environmentId, [
      { ...completed(jobId, "submit", ""), status: "transcribing", text: undefined },
    ]);
    expect(reloadedStore.isDictationLive()).toBe(true);
    reloaded.selectDictationMode("inject");
    expect(callsNamed("setMode")).toEqual([{ environmentId, input: { jobId, mode: "inject" } }]);
    expect(callsNamed("start")).toEqual([]);
  });

  it("dictation phase 4 regression: two tabs recording at once keep both records", () => {
    const shared = new Map<string, string>();
    const storage = {
      get length() {
        return shared.size;
      },
      key: (index: number) => [...shared.keys()][index] ?? null,
      getItem: (key: string) => shared.get(key) ?? null,
      setItem: (key: string, value: string) => void shared.set(key, value),
      removeItem: (key: string) => void shared.delete(key),
      clear: () => shared.clear(),
    } as Storage;
    const record = {
      environmentId,
      target: { kind: "thread", environmentId, threadId } as const,
      mode: "submit" as const,
      createdAt: Date.now(),
    };
    const tabA = createOwnDictationJobs(storage);
    const tabB = createOwnDictationJobs(storage);
    tabA.record("job-from-tab-a", record);
    tabB.record("job-from-tab-b", record);

    const reloadedTabA = createOwnDictationJobs(storage);
    expect(Object.keys(reloadedTabA.store.getState().jobs).toSorted()).toEqual([
      "job-from-tab-a",
      "job-from-tab-b",
    ]);
    // A tab learns the other tab's record from the storage event.
    const keyOfB = [...shared.keys()].find((key) => key.endsWith("job-from-tab-b"))!;
    tabA.applyStorageChange(keyOfB, shared.get(keyOfB)!);
    expect(Object.keys(tabA.store.getState().jobs).toSorted()).toEqual([
      "job-from-tab-a",
      "job-from-tab-b",
    ]);
  });

  it("dictation phase 4 regression: a job another tab already handled fills this tab's marker without a second notice", async () => {
    // Insert mode: since phase 5 of the STT redesign, a send-mode draft sends itself once filled.
    const jobId = await recordAndStop("inject");
    updateOwnDictationJob(jobId, { handled: true });
    deliverDictationJobs(environmentId, [completed(jobId, "inject", "desde la otra pestaña")]);
    await settle();
    expect(prompt()).toBe("Draft desde la otra pestaña");

    // The marker is gone now; the other tab's acknowledgement keeps this one quiet.
    const another = await recordAndStop("inject");
    useComposerDraftStore.getState().setPrompt(draftTarget, "Draft edited");
    updateOwnDictationJob(another, { handled: true });
    deliverDictationJobs(environmentId, [completed(another, "inject", "perdido")]);
    await settle();
    expect(toastManager.add).not.toHaveBeenCalled();
  });
});

describe("dictation delivery is acknowledged once it is durable", () => {
  it("dictation phase 4 regression: a fill whose draft write fails stays unhandled and is written on the next delivery", async () => {
    // Insert mode: since phase 5 of the STT redesign, a send-mode draft sends itself once filled.
    const jobId = await recordAndStop("inject");
    const originalSetItem = localStorage.setItem.bind(localStorage);
    const refuseDrafts = vi
      .spyOn(localStorage, "setItem")
      .mockImplementation((key: string, value: string) => {
        if (key.startsWith("t3code:composer-drafts")) throw new Error("quota exceeded");
        originalSetItem(key, value);
      });

    const jobs = [completed(jobId, "inject", "texto")];
    deliverDictationJobs(environmentId, jobs);
    await settle();
    expect(prompt()).toBe("Draft texto");
    expect(useOwnDictationJobsStore.getState().jobs[jobId]?.handled).toBe(false);
    // The text is in the draft, written through or not: its next send carries the tag.
    expect(withDictatedPrefix(draftTarget, prompt())).toBe("[voiced] Draft texto");

    refuseDrafts.mockRestore();
    deliverDictationJobs(environmentId, [...jobs]);
    await settle();
    expect(useOwnDictationJobsStore.getState().jobs[jobId]?.handled).toBe(true);
    expect(localStorage.getItem("t3code:composer-drafts:v1")).toContain("Draft texto");
    expect(toastManager.add).not.toHaveBeenCalled();
  });
});

describe("restarting a recording", () => {
  it("dictation phase 4 regression: cancel while a restart waits for the microphone keeps the recording cancelled", async () => {
    await startDictation();
    media.holdMicrophone();
    const restarting = restartDictation();
    cancelDictation();
    media.releaseMicrophone();
    await restarting;
    expect(useDictationSessionStore.getState().session).toBeNull();
    expect(isDictationLive()).toBe(false);
    // The microphone opened for the restart (stream 2) was released, not installed.
    expect(media.stoppedTracks).toContain(2);
  });

  it("dictation phase 4 regression: a mode chosen while a restart waits for the microphone is kept", async () => {
    await startDictation();
    media.holdMicrophone();
    const restarting = restartDictation();
    selectDictationMode("inject");
    media.releaseMicrophone();
    await restarting;
    expect(useDictationSessionStore.getState().session).toMatchObject({ mode: "inject" });
    expect(media.recorders).toHaveLength(2);
  });
});

describe("a transcript another tab overwrites", () => {
  /**
   * Tab 2 is a second draft store over the same localStorage, as a second browser tab has. It
   * holds its own copy of the thread's draft and saves the whole store, as tabs do; the browser
   * then tells this tab through a `storage` event.
   */
  async function secondTabSaves(prompt: string) {
    vi.resetModules();
    const tab2 = await import("~/composerDraftStore");
    tab2.useComposerDraftStore.getState().setPrompt(draftTarget, prompt);
    expect(tab2.persistComposerDrafts()).toBe(true);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: tab2.COMPOSER_DRAFT_STORAGE_KEY,
        newValue: localStorage.getItem(tab2.COMPOSER_DRAFT_STORAGE_KEY),
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
  }

  const keptNotices = () =>
    vi
      .mocked(toastManager.add)
      .mock.calls.filter(([toast]) => String(toast.title).includes("kept in Transcriptions"));

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dictation phase 4 regression: a transcript another tab saved over is announced as kept in Transcriptions, once", async () => {
    const jobId = await recordAndStop();
    deliverDictationJobs(environmentId, [completed(jobId, "submit", "texto de esta pestaña")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(prompt()).toBe("Draft texto de esta pestaña");

    await secondTabSaves("Draft texto de la otra pestaña");
    expect(keptNotices()).toHaveLength(1);
    expect(String(keptNotices()[0]![0].description)).toMatch(/another tab/i);

    await secondTabSaves("Draft texto de la otra pestaña, otra vez");
    expect(keptNotices()).toHaveLength(1);
  });

  it("dictation phase 4 regression: another tab's save that keeps the transcript, or a draft the user already sent, raises no notice", async () => {
    const jobId = await recordAndStop();
    deliverDictationJobs(environmentId, [completed(jobId, "submit", "sigue aquí")]);
    await vi.advanceTimersByTimeAsync(0);

    await secondTabSaves("Draft sigue aquí y algo más");
    expect(keptNotices()).toHaveLength(0);

    // The user sent the message in this tab; the transcript left on purpose.
    useComposerDraftStore.getState().setPrompt(draftTarget, "");
    await secondTabSaves("Otra cosa");
    expect(keptNotices()).toHaveLength(0);
  });

  /** A job tab 2 recorded: its record is shared, its marker lives only in tab 2's copy. */
  function jobFromSecondTab(jobId: string) {
    recordOwnDictationJob(DictationJobId.make(jobId), {
      environmentId,
      target: { kind: "thread", environmentId, threadId },
      mode: "submit",
      createdAt: Date.now(),
    });
    return jobId;
  }

  const notices = () => vi.mocked(toastManager.add).mock.calls.map(([toast]) => toast);

  it("dictation phase 4 regression: concurrent stops in two tabs announce only the transcript a save really lost, with the other-tab wording", async () => {
    // Insert mode: since phase 5 of the STT redesign, a send-mode draft sends itself once filled.
    const mine = await recordAndStop("inject");
    const theirs = jobFromSecondTab("7c2d9e41-5b3a-4f60-9d18-0e6f4a2b8c75");
    // Both jobs complete. Tab 2's marker lives only in tab 2's copy, which has not filled yet.
    deliverDictationJobs(environmentId, [
      completed(mine, "inject", "texto de esta pestaña"),
      completed(theirs, "inject", "texto de la otra pestaña"),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(prompt()).toBe("Draft texto de esta pestaña");
    // Nothing was deleted here, so nothing is said yet.
    expect(notices()).toEqual([]);

    // Within the grace period tab 2 fills its marker, saves its copy and acknowledges: its save
    // replaces this tab's transcript in storage. That one loss is announced, with that cause.
    await secondTabSaves("Draft texto de la otra pestaña");
    updateOwnDictationJob(theirs, { handled: true });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(notices()).toHaveLength(1);
    expect(String(notices()[0]!.description)).toMatch(/another tab/i);
    expect(String(notices()[0]!.description)).not.toMatch(/marker was deleted/i);
  });

  it("dictation phase 4 regression: a marker another tab's save removed is announced once, with the other-tab wording, when no tab delivers it", async () => {
    await recordAndStop();
    const orphan = jobFromSecondTab("2e8b4c17-93d5-4a0f-b6e2-5d1c7a9f3b08");
    // Tab 2 closed before the job completed; storage holds neither its marker nor its text.
    const jobs = [completed(orphan, "submit", "texto huérfano")];
    deliverDictationJobs(environmentId, jobs);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(notices()).toHaveLength(1);
    expect(String(notices()[0]!.description)).toMatch(/another tab/i);

    deliverDictationJobs(environmentId, [...jobs]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(notices()).toHaveLength(1);
    expect(useOwnDictationJobsStore.getState().jobs[orphan]).toMatchObject({
      handled: true,
      noticed: true,
    });
  });

  it("dictation phase 4 regression: no notice for a job whose text storage still holds, even when no tab acknowledged it", async () => {
    const saved = jobFromSecondTab("5a9f0c3e-6d21-4b87-8e4c-1f7b2d6a0e93");
    // This tab's own earlier edit is already written; a pending one would rightly overwrite tab 2.
    expect(persistComposerDrafts()).toBe(true);
    // Tab 2 filled and saved, then closed before acknowledging.
    await secondTabSaves("Draft texto guardado");
    deliverDictationJobs(environmentId, [completed(saved, "submit", "texto guardado")]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(notices()).toEqual([]);
  });
});
