import { flushBrowserTasks } from "../test/browserTasks";
import { fakeTimers } from "../../test/render";
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
import { describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  names: new Map<unknown, string>(),
  calls: [] as Array<{ name: string; value: unknown }>,
  /** While set, the start command waits for it. */
  startGate: null as Promise<void> | null,
  /** Where the server's change sequence stood when it accepted the start. */
  startStamp: { epoch: "server-run-1", revision: 5 },
}));

vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: async (_registry: unknown, command: unknown, value: unknown) => {
    const name = fixture.names.get(command) ?? "other";
    fixture.calls.push({ name, value });
    if (name === "start" && fixture.startGate) await fixture.startGate;
    if (name !== "start") return { _tag: "Success", value: undefined };
    const { input } = value as { input: { jobId: string } };
    return { _tag: "Success", value: { id: input.jobId, ...fixture.startStamp } };
  },
}));
vi.mock("@t3tools/client-runtime/state/attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/attachments")>()),
  runAttachmentUploadCycle: async () => ({ status: "uploaded", attachmentId: "dictation-audio" }),
}));

import { toastManager } from "~/components/ui/toast";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  DraftId,
  partializeComposerDraftStoreState,
  persistComposerDrafts,
  resolveComposerDraftKey,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { dictationEnvironment } from "~/state/dictation";
import {
  cancelDictation,
  currentDictationTarget,
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
  forgetDictationEnvironment,
  isDictationLive,
  recordOwnDictationJob,
  updateOwnDictationJob,
  useDictationSessionStore,
  useOwnDictationJobsStore,
} from "./dictationSessionStore";
import { setDictationMediaBackend } from "./recorder";
import { sendWhenReadyKey, useSendWhenReadyStore, withDictatedPrefix } from "./sendWhenReady";
import { readThreadDictationActivity } from "./threadDictationActivity";

const JOB_CREATED_AT = Date.UTC(2026, 9, 3, 12);

const environmentId = EnvironmentId.make("dictation-controller-environment");
const threadId = ThreadId.make("dictation-controller-thread");
const draftTarget = scopeThreadRef(environmentId, threadId);
const otherThreadId = ThreadId.make("dictation-controller-other-thread");
const otherDraftTarget = scopeThreadRef(environmentId, otherThreadId);
let media: ReturnType<typeof createFakeMedia>;
let unregister: () => void;
/** Composers a test registered beside the fixture's own, released when the test ends. */
const extraRegistrations: Array<() => void> = [];
let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

async function setupBrowserFixture0() {
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

  return {
    async [Symbol.asyncDispose]() {
      cancelDictation();
      for (const release of extraRegistrations.splice(0)) release();
      unregister();
      useDictationSessionStore.setState({ session: null, lastJob: null });
      useComposerDraftStore.getState().clearComposerContent(draftTarget);
      useComposerDraftStore.getState().clearComposerContent(otherDraftTarget);
      useSendWhenReadyStore.setState({ drafts: {}, questions: {} });
      setDictationMediaBackend(null);
      Reflect.deleteProperty(navigator, "clipboard");
      vi.restoreAllMocks();
    },
  };
}

const promptOf = (target: typeof draftTarget) =>
  useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "";
const prompt = () => promptOf(draftTarget);
const markers = () => findDictationSlots(prompt()).map((slot) => slot.jobId);

/** Mounts a thread's composer, as navigating to that thread does. */
function showThreadComposer(
  id: ThreadId,
  insertSlot: ((slot: string) => boolean) | null = null,
): () => void {
  const release = registerDictationComposer({
    environmentId,
    target: { kind: "thread", environmentId, threadId: id },
    draftTarget: scopeThreadRef(environmentId, id),
    insertSlot,
  });
  extraRegistrations.push(release);
  return release;
}
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
const settle = () => flushBrowserTasks();

// Keep the cold-start case first: Chromium caches native ESM modules across dynamic imports.
// Seed only durable ownership, without starting this controller and setting its restore latch.
describe("dictation after a reload", () => {
  it("dictation phase 4 regression: after a reload the mode keys pick the transcribing job back up", async () => {
    // Browser test files share one origin: a job another file recorded later would be the
    // device's newest, and only the newest job is restored.
    localStorage.clear();
    using _clock = fakeTimers({ now: JOB_CREATED_AT });
    await using _browserFixture0 = await setupBrowserFixture0();

    const jobId = DictationJobId.make("reloaded-transcribing-job");
    expect(
      recordOwnDictationJob(jobId, {
        environmentId,
        target: { kind: "thread", environmentId, threadId },
        mode: "submit",
        createdAt: JOB_CREATED_AT,
      }),
    ).toBe(true);
    const persistedJobs = createOwnDictationJobs(localStorage).store.getState().jobs;
    useOwnDictationJobsStore.setState({ jobs: persistedJobs });
    expect(persistedJobs[jobId]).toMatchObject({ environmentId, mode: "submit", handled: false });
    // Reload discards the volatile recording and last-job state, but keeps device ownership.
    useDictationSessionStore.setState({ session: null, lastJob: null });
    expect(isDictationLive()).toBe(false);

    deliverDictationJobs(environmentId, [
      { ...completed(jobId, "submit", ""), status: "transcribing", text: undefined },
    ]);
    expect(isDictationLive()).toBe(true);
    selectDictationMode("inject");
    expect(callsNamed("setMode")).toEqual([{ environmentId, input: { jobId, mode: "inject" } }]);
    expect(callsNamed("start")).toEqual([]);
  });
});

describe("dictation mode changes after the recording stopped", () => {
  it("dictation phase 4 regression: a saved job switched to insert drops a marker and fills it", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

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
    await using _browserFixture0 = await setupBrowserFixture0();

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
    await using _browserFixture0 = await setupBrowserFixture0();

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
  it("dictation phase 4 regression: two tabs recording at once keep both records", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

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
      createdAt: JOB_CREATED_AT,
    };
    const tabA = createOwnDictationJobs(storage, () => JOB_CREATED_AT);
    const tabB = createOwnDictationJobs(storage, () => JOB_CREATED_AT);
    tabA.record("job-from-tab-a", record);
    tabB.record("job-from-tab-b", record);

    const reloadedTabA = createOwnDictationJobs(storage, () => JOB_CREATED_AT);
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
    await using _browserFixture0 = await setupBrowserFixture0();

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
    await using _browserFixture0 = await setupBrowserFixture0();

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
    await using _browserFixture0 = await setupBrowserFixture0();

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
    await using _browserFixture0 = await setupBrowserFixture0();

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
  /** Writes another tab's serialized draft without changing this tab's in-memory draft. */
  async function secondTabSaves(prompt: string) {
    const currentPrompt = useComposerDraftStore.getState().getComposerDraft(draftTarget)?.prompt;
    const oldValue = localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
    expect(oldValue, "the other tab starts from persisted drafts").not.toBeNull();
    const persisted = JSON.parse(oldValue!) as {
      state: ReturnType<typeof partializeComposerDraftStoreState>;
      version: number;
    };
    const draftKey = resolveComposerDraftKey(useComposerDraftStore.getState(), draftTarget)!;
    const draft = persisted.state.draftsByThreadKey[draftKey];
    expect(draft, "the other tab holds the same thread's draft").toBeDefined();
    const newValue = JSON.stringify({
      ...persisted,
      state: {
        ...persisted.state,
        draftsByThreadKey: {
          ...persisted.state.draftsByThreadKey,
          [draftKey]: { ...draft, prompt },
        },
      },
    });
    localStorage.setItem(COMPOSER_DRAFT_STORAGE_KEY, newValue);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: COMPOSER_DRAFT_STORAGE_KEY,
        oldValue,
        newValue,
        storageArea: localStorage,
        url: window.location.href,
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(useComposerDraftStore.getState().getComposerDraft(draftTarget)?.prompt).toBe(
      currentPrompt,
    );
  }

  const keptNotices = () =>
    vi
      .mocked(toastManager.add)
      .mock.calls.filter(([toast]) => String(toast.title).includes("kept in Transcriptions"));

  async function setupBrowserFixture1() {
    const _timers = fakeTimers();

    return {
      async [Symbol.asyncDispose]() {
        vi.useRealTimers();

        _timers[Symbol.dispose]();
      },
    };
  }

  it("dictation phase 4 regression: a transcript another tab saved over is announced as kept in Transcriptions, once", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await using _browserFixture1 = await setupBrowserFixture1();

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
    await using _browserFixture0 = await setupBrowserFixture0();
    await using _browserFixture1 = await setupBrowserFixture1();

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
      createdAt: JOB_CREATED_AT,
    });
    return jobId;
  }

  const notices = () => vi.mocked(toastManager.add).mock.calls.map(([toast]) => toast);

  it("dictation phase 4 regression: concurrent stops in two tabs announce only the transcript a save really lost, with the other-tab wording", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await using _browserFixture1 = await setupBrowserFixture1();

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
    await using _browserFixture0 = await setupBrowserFixture0();
    await using _browserFixture1 = await setupBrowserFixture1();

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
    await using _browserFixture0 = await setupBrowserFixture0();
    await using _browserFixture1 = await setupBrowserFixture1();

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

// The server keeps jobs in memory. A server restart, or the retention sweep,
// drops a job the client never saw finish, and the mode keys then claimed
// Alt+S (and the other Alt keys) for good, hiding the Hosts peek. Lists carry
// a cursor (server run and revision) that tells a stale list from one that
// lost the job; the start was accepted at server-run-1, revision 5.
describe("a last job the server no longer knows", () => {
  const transcribingJob = (jobId: string) =>
    ({ ...completed(jobId, "submit", ""), status: "transcribing", text: undefined }) as const;

  it("frees the mode keys when the server's list no longer holds the listed job", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const jobId = await recordAndStop();
    await vi.waitFor(() => expect(callsNamed("start")).toHaveLength(1));
    deliverDictationJobs(environmentId, [transcribingJob(jobId)]);
    expect(isDictationLive()).toBe(true);
    deliverDictationJobs(environmentId, []);
    expect(isDictationLive()).toBe(false);
  });

  it("keeps the mode keys for a list older than the accepted start, then frees them for a later one that lacks the job", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await recordAndStop();
    await vi.waitFor(() => expect(callsNamed("start")).toHaveLength(1));
    // The subscription's older snapshot predates the job, but lands after the start answered.
    deliverDictationJobs(environmentId, [], { epoch: "server-run-1", revision: 4 });
    expect(isDictationLive()).toBe(true);
    // The server lost the job without ever listing it: a list at or past its revision lacks it.
    deliverDictationJobs(environmentId, [], { epoch: "server-run-1", revision: 5 });
    expect(isDictationLive()).toBe(false);
  });

  it("frees the mode keys when the list comes from a new server run", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await recordAndStop();
    await vi.waitFor(() => expect(callsNamed("start")).toHaveLength(1));
    deliverDictationJobs(environmentId, [], { epoch: "server-run-2", revision: 1 });
    expect(isDictationLive()).toBe(false);
  });

  it("keeps the mode keys while the start is still on the wire", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    let openGate = () => undefined as void;
    fixture.startGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    await startDictation();
    const stopping = stopDictation();
    await vi.waitFor(() => expect(callsNamed("start")).toHaveLength(1));
    deliverDictationJobs(environmentId, [], { epoch: "server-run-2", revision: 9 });
    expect(isDictationLive()).toBe(true);
    openGate();
    await stopping;
  });

  it("keeps the mode keys when the server sends no cursor and never listed the job", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await recordAndStop();
    await vi.waitFor(() => expect(callsNamed("start")).toHaveLength(1));
    deliverDictationJobs(environmentId, []);
    expect(isDictationLive()).toBe(true);
  });

  it("gives the mode keys back when a forgotten job is listed transcribing again", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const jobId = await recordAndStop();
    await vi.waitFor(() => expect(callsNamed("start")).toHaveLength(1));
    deliverDictationJobs(environmentId, [], { epoch: "server-run-2", revision: 1 });
    expect(isDictationLive()).toBe(false);
    // A start resent after the reconnect lists the job in the new run.
    deliverDictationJobs(environmentId, [transcribingJob(jobId)], {
      epoch: "server-run-2",
      revision: 2,
    });
    expect(isDictationLive()).toBe(true);
    selectDictationMode("inject");
    expect(callsNamed("setMode")).toEqual([{ environmentId, input: { jobId, mode: "inject" } }]);
  });

  it("hands the keys to a reappeared job a recording deferred once that recording is cancelled", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const jobId = await recordAndStop();
    await vi.waitFor(() => expect(callsNamed("start")).toHaveLength(1));
    deliverDictationJobs(environmentId, [], { epoch: "server-run-2", revision: 1 });
    expect(isDictationLive()).toBe(false);
    const cursor = { epoch: "server-run-2", revision: 2 };
    await startDictation();
    deliverDictationJobs(environmentId, [transcribingJob(jobId)], cursor);
    // The recording defers it; cancelling the recording hands the keys to it at once.
    cancelDictation();
    expect(isDictationLive()).toBe(true);
    selectDictationMode("clipboard");
    expect(callsNamed("setMode").at(-1)).toEqual({
      environmentId,
      input: { jobId, mode: "clipboard" },
    });
  });

  it("does not resurrect a deferred job of an environment removed before the recording is cancelled", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const jobId = await recordAndStop();
    await vi.waitFor(() => expect(callsNamed("start")).toHaveLength(1));
    deliverDictationJobs(environmentId, [], { epoch: "server-run-2", revision: 1 });
    await startDictation();
    deliverDictationJobs(environmentId, [transcribingJob(jobId)], {
      epoch: "server-run-2",
      revision: 2,
    });
    forgetDictationEnvironment(environmentId);
    cancelDictation();
    expect(isDictationLive()).toBe(false);
  });

  it("frees the mode keys when the job's environment is removed", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await recordAndStop();
    forgetDictationEnvironment(EnvironmentId.make("another-environment"));
    expect(isDictationLive()).toBe(true);
    forgetDictationEnvironment(environmentId);
    expect(isDictationLive()).toBe(false);
  });

  it("leaves another environment's last job alone", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await recordAndStop();
    await vi.waitFor(() => expect(callsNamed("start")).toHaveLength(1));
    deliverDictationJobs(EnvironmentId.make("another-environment"), [], {
      epoch: "server-run-2",
      revision: 1,
    });
    expect(isDictationLive()).toBe(true);
  });
});

describe("a recording stays on the thread it started in", () => {
  it("drops its marker into the starting thread's draft after another thread's composer took dictation", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    useComposerDraftStore.getState().setPrompt(otherDraftTarget, "Other");
    const insertIntoOther = vi.fn((_slot: string) => true);

    await startDictation();
    selectDictationMode("inject");
    // Navigating to the other thread: the first composer unmounts, the other one mounts.
    unregister();
    showThreadComposer(otherThreadId, insertIntoOther);
    expect(currentDictationTarget()).toEqual({ kind: "thread", environmentId, threadId });
    await stopDictation();
    const jobId = lastJobId();

    expect(markers()).toEqual([jobId]);
    expect(promptOf(otherDraftTarget)).toBe("Other");
    expect(insertIntoOther).not.toHaveBeenCalled();
    expect(callsNamed("start")[0]).toMatchObject({
      input: { target: { kind: "thread", environmentId, threadId } },
    });
    deliverDictationJobs(environmentId, [completed(jobId, "inject", "hola")]);
    await settle();
    expect(prompt()).toBe("Draft hola");
    expect(promptOf(otherDraftTarget)).toBe("Other");
  });

  it("drops its marker at the starting thread's caret when that thread is shown again", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    const insertIntoReturned = vi.fn((_slot: string) => true);

    await startDictation();
    unregister();
    const releaseOther = showThreadComposer(otherThreadId);
    releaseOther();
    showThreadComposer(threadId, insertIntoReturned);
    await stopDictation();

    expect(insertIntoReturned).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(lastJobId()),
    );
    expect(promptOf(otherDraftTarget)).toBe("");
  });

  it("arms the starting thread's draft in send mode, not the draft of the thread on screen", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await startDictation();
    unregister();
    showThreadComposer(otherThreadId);
    await stopDictation();

    const drafts = useSendWhenReadyStore.getState().drafts;
    expect(drafts[sendWhenReadyKey(draftTarget)]?.armed).toBe(true);
    expect(drafts[sendWhenReadyKey(otherDraftTarget)]?.armed ?? false).toBe(false);
    expect(markers()).toEqual([lastJobId()]);
  });

  it("does not move into another thread's question card", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    const insertIntoQuestion = vi.fn((_slot: string) => true);

    await startDictation();
    selectDictationMode("inject");
    unregister();
    showThreadComposer(otherThreadId);
    extraRegistrations.push(
      registerDictationComposer({
        environmentId,
        target: { kind: "draft", draftId: "other-thread-question-draft" },
        draftTarget: DraftId.make("other-thread-question-draft"),
        insertSlot: insertIntoQuestion,
        question: { requestKey: "other-thread-request", questionId: "question-1" },
        thread: { kind: "thread", environmentId, threadId: otherThreadId },
      }),
    );
    await stopDictation();

    expect(insertIntoQuestion).not.toHaveBeenCalled();
    expect(markers()).toEqual([lastJobId()]);
  });

  it("takes a question card of its own thread while that card has focus", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    const insertIntoQuestion = vi.fn((_slot: string) => true);

    await startDictation();
    extraRegistrations.push(
      registerDictationComposer({
        environmentId,
        target: { kind: "draft", draftId: "own-thread-question-draft" },
        draftTarget: DraftId.make("own-thread-question-draft"),
        insertSlot: insertIntoQuestion,
        question: { requestKey: "own-thread-request", questionId: "question-1" },
        thread: { kind: "thread", environmentId, threadId },
      }),
    );
    await stopDictation();

    expect(insertIntoQuestion).toHaveBeenCalledOnce();
    expect(markers()).toEqual([]);
  });

  it("keeps following the composer when it started in a new-thread draft, as before", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    const newThreadDraft = DraftId.make("dictation-controller-new-thread");
    unregister();
    const releaseDraft = registerDictationComposer({
      environmentId,
      target: { kind: "draft", draftId: newThreadDraft },
      draftTarget: newThreadDraft,
      insertSlot: null,
    });
    extraRegistrations.push(releaseDraft);

    await startDictation();
    releaseDraft();
    showThreadComposer(otherThreadId);
    await stopDictation();

    expect(findDictationSlots(promptOf(otherDraftTarget)).map((slot) => slot.jobId)).toEqual([
      lastJobId(),
    ]);
    useComposerDraftStore.getState().clearComposerContent(newThreadDraft);
  });
});

describe("the thread a recording belongs to", () => {
  const otherRef = otherDraftTarget;

  it("is recording while the recording runs and transcribing until its job completes, on that thread only", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    expect(readThreadDictationActivity(draftTarget)).toBeNull();

    await startDictation();
    selectDictationMode("inject");
    unregister();
    showThreadComposer(otherThreadId);
    expect(readThreadDictationActivity(draftTarget)).toBe("recording");
    expect(readThreadDictationActivity(otherRef)).toBeNull();

    await stopDictation();
    const jobId = lastJobId();
    expect(readThreadDictationActivity(draftTarget)).toBe("transcribing");
    deliverDictationJobs(environmentId, [
      { ...completed(jobId, "inject", ""), status: "transcribing", text: undefined },
    ]);
    expect(readThreadDictationActivity(draftTarget)).toBe("transcribing");
    expect(readThreadDictationActivity(otherRef)).toBeNull();

    deliverDictationJobs(environmentId, [completed(jobId, "inject", "listo")]);
    await settle();
    expect(readThreadDictationActivity(draftTarget)).toBeNull();
  });

  it("is idle again once the recording is cancelled, or stopped into save mode", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await startDictation();
    expect(readThreadDictationActivity(draftTarget)).toBe("recording");
    cancelDictation();
    expect(readThreadDictationActivity(draftTarget)).toBeNull();

    await recordAndStop("clipboard");
    expect(readThreadDictationActivity(draftTarget)).toBeNull();
  });
});
