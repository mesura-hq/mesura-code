/**
 * Phase 7 (mobile dictation), state wiring. Entry points: `finishDictation`,
 * `deliverDictationJobs`, `retryDictationJob` (`./dictation`) and
 * `sendComposerDraftToThread` (`./use-thread-composer-state`), over the real composer
 * draft store (`./use-composer-drafts`). No component is mounted: a thread whose
 * composer is not on screen must still fill and send. Stubbed edges: the network
 * (`./dictationTransport`), the outbox write (`enqueueThreadOutboxMessage`), draft
 * persistence on disk, and the thread shell and server config atoms.
 */
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import {
  DictationJobId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type DictationJob,
} from "@t3tools/contracts";
import { formatDictationSlot } from "@t3tools/shared/dictationSlots";
import { vi } from "vite-plus/test";

const fixture = vi.hoisted(() => {
  const document = JSON.stringify({ schemaVersion: 1, drafts: {} });
  const fixtureFiles = () => fixture;
  let uuid = 0;
  return {
    nextUuid: () => `uuid-${(uuid += 1)}`,
    upload: vi.fn(async (..._args: unknown[]) => "attachment-1"),
    start: vi.fn(async (..._args: unknown[]) => undefined),
    enqueue: vi.fn(async (_message: unknown) => undefined),
    shells: new Map<string, unknown>(),
    jobsAtom: null as null | ((environmentId: string) => unknown),
    configs: new Map<string, unknown>(),
    /** Files by name: the drafts file, the dictation job records, and recordings by uri. */
    files: new Map<string, string>(),
    missingFiles: new Set<string>(),
    File: class {
      readonly name: string;
      readonly parentDirectory: unknown;
      constructor(parentOrUri: unknown, name?: string) {
        this.parentDirectory = parentOrUri;
        this.name = name ?? String(parentOrUri);
      }
      get exists() {
        if (fixtureFiles().missingFiles.has(this.name)) return false;
        return this.name.startsWith("file://") || fixtureFiles().files.has(this.name);
      }
      get size() {
        return 1024;
      }
      create() {}
      delete() {
        fixtureFiles().files.delete(this.name);
      }
      async text() {
        return fixtureFiles().files.get(this.name) ?? document;
      }
      write(value: string) {
        fixtureFiles().files.set(this.name, value);
      }
      moveSync(destination: { name: string }) {
        const files = fixtureFiles().files;
        files.set(destination.name, files.get(this.name) ?? "");
        files.delete(this.name);
      }
    },
    Directory: class {
      create() {}
      list() {
        return [];
      }
    },
  };
});

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  Platform: { OS: "android", select: (options: { android?: unknown }) => options.android },
  AppState: { addEventListener: () => ({ remove() {} }), currentState: "active" },
}));
vi.mock("expo-file-system", () => ({
  Directory: fixture.Directory,
  File: fixture.File,
  Paths: { document: { uri: "file:///documents" }, cache: { uri: "file:///cache" } },
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => fixture.nextUuid() }));
vi.mock("../lib/uuid", () => ({ uuidv4: () => fixture.nextUuid(), randomHex: () => "0000" }));
vi.mock("./dictationTransport", () => ({
  uploadDictationAudio: fixture.upload,
  startDictationJob: fixture.start,
}));
vi.mock("./thread-outbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./thread-outbox")>()),
  enqueueThreadOutboxMessage: fixture.enqueue,
}));
// The same storage-adjacent edges the composer draft store's own test stubs.
vi.mock("./assets", () => ({ assetEnvironment: {} }));
vi.mock("./attachments", () => ({ attachmentEnvironment: {} }));
vi.mock("./session", () => ({ environmentSession: {} }));
vi.mock("../lib/attachmentUpload", () => ({ releasePendingAttachmentUploads: vi.fn() }));
vi.mock("../features/sharing/incoming-share-storage", () => ({
  loadIncomingShareDrafts: async () => [],
}));
// Hook-only modules of the composer state; the off-screen sender must not need them.
vi.mock("./use-remote-environment-registry", () => ({ setPendingConnectionError: vi.fn() }));
vi.mock("./use-thread-selection", () => ({ useThreadSelection: vi.fn() }));
vi.mock("./use-thread-detail", () => ({ useSelectedThreadDetail: vi.fn() }));
vi.mock("./use-thread-outbox", () => ({
  dispatchingQueuedMessageIdAtom: null,
  useThreadOutboxMessages: vi.fn(),
}));
vi.mock("./use-atom-command", () => ({ useAtomCommand: vi.fn() }));
vi.mock("./entities", () => ({
  useServerConfigs: vi.fn(),
  useProject: vi.fn(),
  useThreadShell: vi.fn(),
}));
vi.mock("./threads", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const shellAtom = Atom.family((key: string) => Atom.make(() => fixture.shells.get(key) ?? null));
  return {
    environmentThreadShells: {
      threadShellAtom: (ref: { environmentId: string; threadId: string }) =>
        shellAtom(`${ref.environmentId}:${ref.threadId}`),
    },
    threadEnvironment: {},
    environmentThreads: {},
    environmentThreadDetails: {},
  };
});
// The environment job stream, as a writable atom per environment.
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/dictation", async (importOriginal) => {
  const { Atom } = await import("effect/unstable/reactivity");
  const jobs = Atom.family((_key: string) => Atom.make<unknown>(undefined).pipe(Atom.keepAlive));
  fixture.jobsAtom = (environmentId: string) => jobs(environmentId);
  return {
    ...(await importOriginal<typeof import("@t3tools/client-runtime/dictation")>()),
    createDictationEnvironmentAtoms: () => ({
      jobs: ({ environmentId }: { environmentId: string }) => jobs(environmentId),
      start: Symbol("start"),
      retry: Symbol("retry"),
      cancel: Symbol("cancel"),
      setMode: Symbol("setMode"),
    }),
  };
});
vi.mock("./server", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    serverEnvironment: {
      configValueAtom: Atom.family((environmentId: string) =>
        Atom.make(() => fixture.configs.get(environmentId) ?? null),
      ),
    },
    environmentServerConfigsAtom: Atom.make(() => fixture.configs),
  };
});

import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import { Alert } from "react-native";
import {
  readUserInputDraftCustomAnswer,
  setUserInputDraftCustomAnswerText,
} from "./use-selected-thread-requests";
import {
  deliverDictationJobs,
  discardDictationJob,
  finishDictation,
  registerDictationDraftSender,
  readDictationJobFailure,
  forgetDictationSessionState,
  isDictationJobRetryable,
  retryDictationJob,
  watchDictationJobs,
  type DictationOwner,
} from "./dictation";
import { AsyncResult, type Atom } from "effect/unstable/reactivity";
import {
  composerDraftsAtom,
  ensureComposerDraftsLoaded,
  getComposerDraftSnapshot,
  rememberComposerDraftSelection,
  resetComposerDraftsLoadState,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "./use-composer-drafts";
import { sendComposerDraftToThread } from "./use-thread-composer-state";
import { isDictationDraftArmed } from "./dictationDrafts";

const environmentId = EnvironmentId.make("dictation-state-environment");
const threadId = ThreadId.make("dictation-state-thread");
const draftKey = scopedThreadKey(environmentId, threadId);
const owner: DictationOwner = {
  environmentId,
  draftKey,
  target: { kind: "thread", environmentId, threadId },
};
const recording = { uri: "file:///tmp/dictation.m4a", durationMs: 2_400, mimeType: "audio/mp4" };

const completed = (id: string, text: string) =>
  ({
    id: DictationJobId.make(id),
    status: "completed",
    text,
    createdAt: "2026-10-04T10:00:00.000Z",
    completedAt: "2026-10-04T10:00:03.000Z",
  }) as unknown as DictationJob;

const draftText = () => getComposerDraftSnapshot(draftKey).text;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  ensureComposerDraftsLoaded();
  await waitForComposerDraftsLoaded();
  fixture.shells.set(`${environmentId}:${threadId}`, {
    id: threadId,
    environmentId,
    projectId: "dictation-state-project",
    title: "Dictation",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    latestTurn: null,
  });
  fixture.configs.set(environmentId, null);
});

afterEach(() => {
  appAtomRegistry.set(composerDraftsAtom, {});
  resetComposerDraftsLoadState();
  fixture.upload.mockReset();
  fixture.upload.mockResolvedValue("attachment-1");
  fixture.start.mockReset();
  fixture.start.mockResolvedValue(undefined);
  fixture.enqueue.mockClear();
  forgetDictationSessionState();
  // The stream atom outlives a test; a restart starts before the server's first snapshot.
  if (fixture.jobsAtom) {
    appAtomRegistry.set(fixture.jobsAtom(environmentId) as Atom.Writable<unknown>, undefined);
  }
  fixture.files.delete("dictation-jobs.json");
  fixture.missingFiles.clear();
});

describe("mobile dictation stop", () => {
  it("drops the mobile dictation marker at the remembered caret before the upload starts", async () => {
    setComposerDraftText(draftKey, "hello world");
    rememberComposerDraftSelection(draftKey, "hello world", { start: 5, end: 5 });
    let textAtUpload = "";
    fixture.upload.mockImplementation(async () => {
      textAtUpload = draftText();
      return "attachment-1";
    });

    const { jobId, status } = await finishDictation({ owner, mode: "inject", recording });

    const slot = formatDictationSlot(jobId);
    expect(status).toBe("started");
    expect(textAtUpload).toContain(slot);
    const text = draftText();
    expect(text.indexOf(slot)).toBeGreaterThanOrEqual("hello".length);
    expect(text.indexOf(slot)).toBeLessThan(text.indexOf("world"));
    expect(fixture.upload).toHaveBeenCalledWith(environmentId, jobId, recording);
    expect(fixture.start).toHaveBeenCalledWith(environmentId, {
      jobId,
      attachmentId: "attachment-1",
      durationMs: recording.durationMs,
      mode: "inject",
      target: owner.target,
    });
    expect(fixture.upload.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.start.mock.invocationCallOrder[0]!,
    );
  });

  it("appends the mobile dictation marker when no caret was remembered for the text", async () => {
    setComposerDraftText(draftKey, "typed first");
    const { jobId } = await finishDictation({ owner, mode: "inject", recording });
    expect(draftText().trimEnd().endsWith(formatDictationSlot(jobId))).toBe(true);
    expect(draftText().startsWith("typed first")).toBe(true);
  });

  it("keeps a failed mobile upload's marker and retries it from the kept recording", async () => {
    setComposerDraftText(draftKey, "note");
    fixture.upload.mockRejectedValueOnce(new Error("offline"));

    const { jobId, status } = await finishDictation({ owner, mode: "inject", recording });

    expect(status).toBe("failed");
    expect(draftText()).toContain(formatDictationSlot(jobId));
    expect(readDictationJobFailure(jobId)).toContain("offline");
    expect(fixture.start).not.toHaveBeenCalled();

    await expect(retryDictationJob(jobId)).resolves.toBe("started");
    expect(fixture.upload).toHaveBeenLastCalledWith(environmentId, jobId, recording);
    expect(fixture.start).toHaveBeenCalledOnce();
    expect(readDictationJobFailure(jobId)).toBeNull();
  });
});

describe("mobile dictation fill", () => {
  it("fills a completed mobile job into a draft whose composer is not mounted, once per job id", async () => {
    setComposerDraftText(draftKey, "please");
    const { jobId } = await finishDictation({ owner, mode: "inject", recording });

    deliverDictationJobs(environmentId, [completed(jobId, "fix the build")]);
    expect(draftText()).toBe("please fix the build");

    // The same job arriving again (a reconnect snapshot) must not fill a second time,
    // even when a copy of its marker came back into the draft.
    setComposerDraftText(draftKey, `please fix the build ${formatDictationSlot(jobId)}`);
    deliverDictationJobs(environmentId, [completed(jobId, "fix the build")]);
    expect(draftText()).toBe(`please fix the build ${formatDictationSlot(jobId)}`);
  });

  it("leaves a mobile draft alone for a job this device did not record", () => {
    setComposerDraftText(draftKey, `x ${formatDictationSlot(DictationJobId.make("foreign"))}`);
    deliverDictationJobs(environmentId, [completed("foreign", "not mine")]);
    expect(draftText()).toContain("t3-context://v1/dictation/foreign");
  });
});

describe("mobile dictation send when ready", () => {
  it("sends an armed mobile thread draft off screen when its last marker fills, with one voiced prefix", async () => {
    setComposerDraftText(draftKey, "first");
    const one = await finishDictation({ owner, mode: "submit", recording });
    const two = await finishDictation({ owner, mode: "submit", recording });

    deliverDictationJobs(environmentId, [completed(one.jobId, "part one")]);
    await flush();
    expect(fixture.enqueue).not.toHaveBeenCalled();

    deliverDictationJobs(environmentId, [
      completed(two.jobId, "part two"),
      completed(one.jobId, "part one"),
    ]);
    await flush();

    expect(fixture.enqueue).toHaveBeenCalledOnce();
    const sent = fixture.enqueue.mock.calls[0]![0] as { text: string; threadId: string };
    expect(sent.threadId).toBe(threadId);
    expect(sent.text).toBe("[voiced] first part one part two");
    expect(sent.text.match(/\[voiced\]/g)).toHaveLength(1);
    expect(draftText()).toBe("");
  });

  it("does not send an insert-mode mobile draft by itself, and a manual send carries the prefix", async () => {
    setComposerDraftText(draftKey, "manual");
    const { jobId } = await finishDictation({ owner, mode: "inject", recording });
    deliverDictationJobs(environmentId, [completed(jobId, "and spoken")]);
    await flush();
    expect(fixture.enqueue).not.toHaveBeenCalled();

    await sendComposerDraftToThread({ environmentId, threadId });
    expect(fixture.enqueue).toHaveBeenCalledOnce();
    expect((fixture.enqueue.mock.calls[0]![0] as { text: string }).text).toBe(
      "[voiced] manual and spoken",
    );
    expect(draftText()).toBe("");
  });
});

describe("mobile dictation job stream", () => {
  it("fills a mobile draft from the environment job stream with no composer mounted", async () => {
    setComposerDraftText(draftKey, "streamed");
    const { jobId } = await finishDictation({ owner, mode: "inject", recording });
    const stop = watchDictationJobs(environmentId);
    try {
      appAtomRegistry.set(
        fixture.jobsAtom!(environmentId) as Atom.Writable<unknown>,
        AsyncResult.success([completed(jobId, "from the server")]),
      );
      // The stream first settles records a restart left on disk, then delivers.
      await vi.waitFor(() => expect(draftText()).toBe("streamed from the server"));
    } finally {
      stop();
    }
  });
});

describe("mobile dictation new-task drafts", () => {
  const newTaskKey = "new-task:dictation-state-draft";
  const newTaskOwner: DictationOwner = {
    environmentId,
    draftKey: newTaskKey,
    target: { kind: "draft", draftId: newTaskKey },
  };
  const newTaskText = () => getComposerDraftSnapshot(newTaskKey).text;

  it("sends an armed mobile new-task draft through its mounted screen when its last marker fills", async () => {
    const send = vi.fn();
    const unregister = registerDictationDraftSender(newTaskKey, send);
    try {
      setComposerDraftText(newTaskKey, "start");
      const { jobId } = await finishDictation({ owner: newTaskOwner, mode: "submit", recording });
      deliverDictationJobs(environmentId, [completed(jobId, "a new task")]);
      expect(newTaskText()).toBe("start a new task");
      expect(send).toHaveBeenCalledOnce();
      expect(fixture.enqueue).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("disarms an armed mobile new-task draft whose screen is gone, keeps its text and says so", async () => {
    const alert = vi.mocked(Alert.alert);
    alert.mockClear();
    setComposerDraftText(newTaskKey, "later");
    const { jobId } = await finishDictation({ owner: newTaskOwner, mode: "submit", recording });
    deliverDictationJobs(environmentId, [completed(jobId, "spoken")]);
    expect(newTaskText()).toBe("later spoken");
    expect(fixture.enqueue).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledOnce();
    expect(alert.mock.calls[0]![0]).toBe("The dictated draft was not sent");

    // Disarmed: a later screen mount does not send it behind the user's back.
    const send = vi.fn();
    const unregister = registerDictationDraftSender(newTaskKey, send);
    const second = await finishDictation({ owner: newTaskOwner, mode: "inject", recording });
    deliverDictationJobs(environmentId, [completed(second.jobId, "more")]);
    unregister();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("mobile dictation discard", () => {
  it("discards a failed mobile job's marker and its failure", async () => {
    setComposerDraftText(draftKey, "keep this");
    fixture.upload.mockRejectedValueOnce(new Error("offline"));
    const { jobId } = await finishDictation({ owner, mode: "inject", recording });
    expect(readDictationJobFailure(jobId)).toContain("offline");

    discardDictationJob(jobId);
    expect(draftText()).toBe("keep this");
    expect(readDictationJobFailure(jobId)).toBeNull();
  });
});

describe("mobile dictation question answers", () => {
  const requestKey = JSON.stringify([environmentId, threadId, "dictation-state-request"]);
  const questionOwner: DictationOwner = { ...owner, question: { requestKey, questionId: "scope" } };

  it("fills a mobile question answer where its marker sits and never arms a send", async () => {
    setUserInputDraftCustomAnswerText(requestKey, "scope", "Only the API");
    setComposerDraftText(draftKey, "thread draft");
    const { jobId } = await finishDictation({ owner: questionOwner, mode: "submit", recording });
    expect(readUserInputDraftCustomAnswer(requestKey, "scope")).toBe(
      `Only the API ${formatDictationSlot(jobId)}`,
    );
    expect(draftText()).toBe("thread draft");

    deliverDictationJobs(environmentId, [completed(jobId, "and the CLI")]);
    await flush();
    expect(readUserInputDraftCustomAnswer(requestKey, "scope")).toBe("Only the API and the CLI");
    expect(fixture.enqueue).not.toHaveBeenCalled();
  });
});

const failed = (id: string, failure: string) =>
  ({
    id: DictationJobId.make(id),
    status: "failed",
    failure,
    createdAt: "2026-10-04T10:00:00.000Z",
    completedAt: "2026-10-04T10:00:02.000Z",
  }) as unknown as DictationJob;
const transcribing = (id: string) =>
  ({
    id: DictationJobId.make(id),
    status: "transcribing",
    createdAt: "2026-10-04T10:00:00.000Z",
  }) as unknown as DictationJob;

describe("mobile dictation review regressions", () => {
  // P1-1: Send before the transcript arrives arms the draft instead of sending the marker.
  it("arms instead of sending when a mobile thread draft is sent with a pending marker", async () => {
    setComposerDraftText(draftKey, "fix");
    const { jobId } = await finishDictation({ owner, mode: "inject", recording });

    await expect(sendComposerDraftToThread({ environmentId, threadId })).resolves.toBeNull();
    expect(fixture.enqueue).not.toHaveBeenCalled();
    expect(draftText()).toContain(formatDictationSlot(jobId));
    expect(isDictationDraftArmed(draftKey)).toBe(true);

    deliverDictationJobs(environmentId, [completed(jobId, "the build")]);
    await flush();
    expect(fixture.enqueue).toHaveBeenCalledOnce();
    expect((fixture.enqueue.mock.calls[0]![0] as { text: string }).text).toBe(
      "[voiced] fix the build",
    );
  });

  // P1-3: the reviewer's sequence. A send-mode draft is cleared before its transcript arrives,
  // then an insert-mode recording lands in the replacement draft.
  it("never lets a cleared send-mode mobile draft send its insert-mode replacement", async () => {
    setComposerDraftText(draftKey, "old message");
    const first = await finishDictation({ owner, mode: "submit", recording });
    expect(isDictationDraftArmed(draftKey)).toBe(true);

    setComposerDraftText(draftKey, "");
    expect(isDictationDraftArmed(draftKey)).toBe(false);

    setComposerDraftText(draftKey, "new insert draft");
    const second = await finishDictation({ owner, mode: "inject", recording });
    deliverDictationJobs(environmentId, [completed(first.jobId, "old speech")]);
    deliverDictationJobs(environmentId, [completed(second.jobId, "new speech")]);
    await flush();

    expect(draftText()).toBe("new insert draft new speech");
    expect(fixture.enqueue).not.toHaveBeenCalled();
    expect(isDictationDraftArmed(draftKey)).toBe(false);
  });

  it("keeps an old mobile completion from sending a draft re-armed after a send", async () => {
    setComposerDraftText(draftKey, "first");
    const old = await finishDictation({ owner, mode: "inject", recording });
    // The user removes the marker and sends by hand; a new send-mode recording follows.
    setComposerDraftText(draftKey, "first");
    await sendComposerDraftToThread({ environmentId, threadId });
    fixture.enqueue.mockClear();
    setComposerDraftText(draftKey, "second");
    const next = await finishDictation({ owner, mode: "submit", recording });
    // The old job's marker is pasted back into the new draft. The new job fills first, so the
    // old completion is the one that empties the draft of markers; it must not send it.
    setComposerDraftText(draftKey, `${draftText()} ${formatDictationSlot(old.jobId)}`);
    deliverDictationJobs(environmentId, [completed(next.jobId, "fresh")]);
    await flush();
    expect(fixture.enqueue).not.toHaveBeenCalled();
    deliverDictationJobs(environmentId, [completed(old.jobId, "stale")]);
    await flush();
    expect(fixture.enqueue).not.toHaveBeenCalled();
    expect(draftText()).toBe("second fresh stale");
  });

  // P2-1: a completion straight after a failure clears the failure before delivery.
  it("clears a mobile job's failure when it completes straight after failing", async () => {
    setComposerDraftText(draftKey, "typed");
    const { jobId } = await finishDictation({ owner, mode: "inject", recording });
    deliverDictationJobs(environmentId, [failed(jobId, "first attempt failed")]);
    expect(readDictationJobFailure(jobId)).toBe("first attempt failed");

    deliverDictationJobs(environmentId, [completed(jobId, "recovered")]);
    expect(readDictationJobFailure(jobId)).toBeNull();
    expect(draftText()).toBe("typed recovered");
  });
});

describe("mobile dictation restart", () => {
  /** A stop whose upload never finishes: the process dies during it. */
  async function stopThenDie(mode: "inject" | "submit" = "inject") {
    fixture.upload.mockImplementationOnce(() => new Promise<string>(() => undefined));
    let jobId = "";
    void finishDictation({ owner, mode, recording });
    await vi.waitFor(() => expect(fixture.upload).toHaveBeenCalledOnce());
    jobId = String(fixture.upload.mock.calls[0]![1]);
    forgetDictationSessionState();
    return DictationJobId.make(jobId);
  }

  async function restartWith(jobs: ReadonlyArray<DictationJob>) {
    const stop = watchDictationJobs(environmentId);
    appAtomRegistry.set(
      fixture.jobsAtom!(environmentId) as Atom.Writable<unknown>,
      AsyncResult.success(jobs),
    );
    return stop;
  }

  it("persists the mobile job record before its upload starts", async () => {
    setComposerDraftText(draftKey, "before upload");
    let recordAtUpload = "";
    fixture.upload.mockImplementationOnce(async () => {
      recordAtUpload = fixture.files.get("dictation-jobs.json") ?? "";
      return "attachment-1";
    });
    const { jobId } = await finishDictation({ owner, mode: "inject", recording });
    expect(recordAtUpload).toContain(jobId);
    expect(recordAtUpload).toContain(recording.uri);
  });

  it("turns a mobile job the server never received into an interrupted failure that Retry uploads again", async () => {
    setComposerDraftText(draftKey, "restart draft");
    const jobId = await stopThenDie();
    expect(draftText()).toContain(formatDictationSlot(jobId));

    const stop = await restartWith([]);
    try {
      await vi.waitFor(() => expect(readDictationJobFailure(jobId)).toBe("Interrupted"));
      expect(isDictationJobRetryable(jobId)).toBe(true);
      expect(draftText()).toContain(formatDictationSlot(jobId));

      fixture.upload.mockClear();
      await expect(retryDictationJob(jobId)).resolves.toBe("started");
      expect(fixture.upload).toHaveBeenCalledWith(environmentId, jobId, recording);
      expect(fixture.start).toHaveBeenCalledOnce();
      expect(readDictationJobFailure(jobId)).toBeNull();
    } finally {
      stop();
    }
  });

  it("offers only Discard for an interrupted mobile job whose recording file is gone", async () => {
    setComposerDraftText(draftKey, "lost recording");
    const jobId = await stopThenDie();
    fixture.missingFiles.add(recording.uri);

    const stop = await restartWith([]);
    try {
      await vi.waitFor(() => expect(readDictationJobFailure(jobId)).toBe("Interrupted"));
      expect(isDictationJobRetryable(jobId)).toBe(false);
      discardDictationJob(jobId);
      expect(draftText()).toBe("lost recording");
    } finally {
      stop();
    }
  });

  it("adopts a mobile job the server knows after a restart and fills it when it completes", async () => {
    setComposerDraftText(draftKey, "known");
    const jobId = await stopThenDie("submit");

    const stop = await restartWith([transcribing(jobId)]);
    try {
      await vi.waitFor(() => expect(isDictationDraftArmed(draftKey)).toBe(true));
      expect(readDictationJobFailure(jobId)).toBeNull();
      appAtomRegistry.set(
        fixture.jobsAtom!(environmentId) as Atom.Writable<unknown>,
        AsyncResult.success([completed(jobId, "after restart")]),
      );
      await vi.waitFor(() => expect(fixture.enqueue).toHaveBeenCalledOnce());
      expect((fixture.enqueue.mock.calls[0]![0] as { text: string }).text).toBe(
        "[voiced] known after restart",
      );
    } finally {
      stop();
    }
  });
});
