// @vitest-environment happy-dom
/**
 * Entry point: AppRoot, with a memory router whose root renders the real
 * AppSidebarLayout around the real ChatView, as `_chat.tsx` does. The layout is
 * where the app-wide dictation listener lives, so a job that completes for a
 * thread that is not on screen is still filled.
 *
 * Phase 4 of the STT redesign, criteria 1–8: record in the desktop and web
 * window and place the marker.
 *
 * Boundaries the fixture replaces, and nothing else:
 * - The browser media APIs, through the `setDictationMediaBackend` seam in
 *   `dictation/recorder.ts` (happy-dom has no getUserMedia, MediaRecorder or
 *   AudioContext).
 * - The upload, at `runAttachmentUploadCycle`, the cycle the plan names.
 * - Every RPC command, at `runAtomCommand` and `useAtomCommand`, so the
 *   dictation start and setMode commands are observed as they leave.
 * - The job stream, at phase 2's `useDictationJobs` hook: the fixture pushes
 *   job lists through it as the server would.
 * - The sidebars and the thread entity reads, as `AppRoot.pendingUserInput.test.tsx` does.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DictationJobId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type DictationJob,
  type DictationMode,
  type DictationTarget,
} from "@t3tools/contracts";
import { findDictationSlots, formatDictationSlot } from "@t3tools/shared/dictationSlots";
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  type LexicalEditor,
  type TextNode,
} from "lexical";
import type { Thread } from "./types";
import type { AppRouter } from "./router";

const fixture = vi.hoisted(() => ({
  thread: null as Thread | null,
  empty: [],
  threadListeners: new Set<() => void>(),
  /** Set after import: the dictation commands and the turn start, by name. */
  dictationCommands: new Map<unknown, string>(),
  dictationCalls: [] as Array<{ name: string; value: unknown }>,
  uploads: [] as Array<{ upload: unknown; promptAtUpload: string | null }>,
  readPromptAtUpload: (() => null) as () => string | null,
  jobs: [] as unknown[],
  /** False until the subscription's snapshot arrives, as for a fresh subscription. */
  jobsLoaded: true,
  jobListeners: new Set<() => void>(),
  environments: [
    {
      environmentId: "dictation-phase-four-environment",
      label: "Fence environment",
      connection: { phase: "connected" },
      serverConfig: {
        environment: { capabilities: {} },
        providers: [
          {
            instanceId: "codex",
            driver: "codex",
            enabled: true,
            installed: true,
            status: "ready",
            version: null,
            auth: { status: "authenticated" },
            checkedAt: "2026-10-03T12:00:00.000Z",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ],
      },
    },
  ],
}));

/** Every command goes through here; dictation commands are recorded by name. */
function dispatchCommand(command: unknown, value: unknown) {
  const name = fixture.dictationCommands.get(command);
  if (name) fixture.dictationCalls.push({ name, value });
  // Shaped for the composer's provider refresh, the one caller that reads a value here.
  return Promise.resolve({ _tag: "Success" as const, value: { providers: [] } });
}

vi.mock("./state/entities", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  const useFixtureThread = () =>
    useSyncExternalStore(
      (listener) => {
        fixture.threadListeners.add(listener);
        return () => {
          fixture.threadListeners.delete(listener);
        };
      },
      () => fixture.thread,
    );
  return {
    ...(await importOriginal<typeof import("./state/entities")>()),
    useThread: useFixtureThread,
    readThread: () => fixture.thread,
    useThreadShell: useFixtureThread,
    useThreadRefs: () => fixture.empty,
    useThreadShells: () => fixture.empty,
    useProjects: () => fixture.empty,
    useProject: () => ({
      id: "dictation-phase-four-project",
      environmentId: "dictation-phase-four-environment",
      title: "Dictation fence",
      workspaceRoot: "/tmp/dictation-fence",
      scripts: [],
      createdAt: "2026-10-03T12:00:00.000Z",
      defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" },
    }),
  };
});
vi.mock("./state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state/environments")>()),
  useEnvironments: () => ({ environments: fixture.environments, isReady: true }),
  usePrimaryEnvironment: () => null,
}));
vi.mock("./state/query", () => ({
  useEnvironmentQuery: () => ({
    data: null,
    error: null,
    isPending: false,
    isSuccess: false,
    refresh: () => undefined,
  }),
}));
vi.mock("./state/threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state/threads")>();
  const { EMPTY_ENVIRONMENT_THREAD_STATE } = await import("@t3tools/client-runtime/state/threads");
  return { ...actual, useEnvironmentThread: () => EMPTY_ENVIRONMENT_THREAD_STATE };
});
vi.mock("./state/dictation", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    fixture.jobListeners.add(listener);
    return () => {
      fixture.jobListeners.delete(listener);
    };
  };
  const none: unknown[] = [];
  return {
    ...(await importOriginal<typeof import("./state/dictation")>()),
    useDictationJobs: (environmentId: string | null) => {
      const jobs = useSyncExternalStore(subscribe, () =>
        environmentId === fixture.environments[0]!.environmentId ? fixture.jobs : none,
      );
      const loaded = useSyncExternalStore(subscribe, () => fixture.jobsLoaded);
      return { jobs, loaded };
    },
  };
});
vi.mock("./state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => (value: unknown) => dispatchCommand(command, value),
}));
vi.mock("./state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => () => dispatchCommand(null, null),
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: (_registry: unknown, command: unknown, value: unknown) =>
    dispatchCommand(command, value),
}));
vi.mock("@t3tools/client-runtime/state/attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/attachments")>()),
  runAttachmentUploadCycle: async (input: { upload: unknown }) => {
    fixture.uploads.push({ upload: input.upload, promptAtUpload: fixture.readPromptAtUpload() });
    return { status: "uploaded", attachmentId: `dictation-audio-${fixture.uploads.length}` };
  },
}));
// The toggle ships unbound; this fixture binds it the way a user's keybindings file would.
vi.mock("./state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state/server")>();
  const { Atom } = await import("effect/unstable/reactivity");
  const { compileResolvedKeybindingsConfig, mergeWithDefaultKeybindings } =
    await import("@t3tools/shared/keybindings");
  return {
    ...actual,
    primaryServerKeybindingsAtom: Atom.make(() =>
      mergeWithDefaultKeybindings(
        compileResolvedKeybindingsConfig([
          { key: "ctrl+alt+d", command: "dictation.toggle" as never },
        ]),
      ),
    ),
  };
});
vi.mock("./hooks/useSettings", async (importOriginal) => {
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts/settings");
  const settings = { ...DEFAULT_CLIENT_SETTINGS, ...DEFAULT_SERVER_SETTINGS };
  return {
    ...(await importOriginal<typeof import("./hooks/useSettings")>()),
    useEnvironmentSettings: () => settings,
    useClientSettings: (select?: (value: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
      select ? select(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS,
    useClientSettingsHydrated: () => true,
    useLegacySidebarEnabled: () => false,
  };
});
vi.mock("./hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => () => dispatchCommand(null, null),
}));
vi.mock("./hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    settleThread: () => dispatchCommand(null, null),
    pinThread: () => dispatchCommand(null, null),
    confirmAndUnpinThread: () => dispatchCommand(null, null),
  }),
}));
vi.mock("./components/Sidebar", () => ({ default: () => null }));
vi.mock("./components/LegacySidebar", () => ({ default: () => null }));
vi.mock("./components/preview/PreviewAutomationHosts", () => ({
  PreviewAutomationHosts: () => null,
}));
vi.mock("./browser/ElectronBrowserHost", () => ({ ElectronBrowserHost: () => null }));
vi.mock("./components/QuitHoldOverlay", () => ({ QuitHoldOverlay: () => null }));
vi.mock("./components/chat/ChatHeader", () => ({ ChatHeader: () => null }));
vi.mock("./components/BranchToolbar", () => ({ BranchToolbar: () => null }));
vi.mock("@legendapp/list/react", () => ({
  LegendList: ({
    data,
    renderItem,
    ListHeaderComponent,
    ListFooterComponent,
  }: {
    data: Array<{ id: string }>;
    renderItem: (input: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) => (
    <div>
      {ListHeaderComponent}
      {data.map((item) => (
        <div key={item.id}>{renderItem({ item })}</div>
      ))}
      {ListFooterComponent}
    </div>
  ),
}));

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AppRoot } from "./AppRoot";
import { AppSidebarLayout } from "./components/AppSidebarLayout";
import ChatView from "./components/ChatView";
import { toastManager } from "./components/ui/toast";
import { persistComposerDrafts, useComposerDraftStore } from "./composerDraftStore";
import { createFakeMedia } from "./dictation/dictationMedia.testFixtures";
import { setDictationMediaBackend } from "./dictation/recorder";
import { dictationEnvironment } from "./state/dictation";
import { threadEnvironment } from "./state/threads";

const environmentId = EnvironmentId.make("dictation-phase-four-environment");
const threadId = ThreadId.make("dictation-phase-four-thread");
const offScreenThreadId = ThreadId.make("dictation-phase-four-other-thread");
const onScreenTarget = scopeThreadRef(environmentId, threadId);
const offScreenTarget = scopeThreadRef(environmentId, offScreenThreadId);
const now = "2026-10-03T12:00:00.000Z";
let root: Root | undefined;
let container: HTMLDivElement;
let media: ReturnType<typeof createFakeMedia>;
let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

// ── Fixture ─────────────────────────────────────────────────────────────────

function makeThread(): Thread {
  return {
    id: threadId,
    environmentId,
    projectId: ProjectId.make("dictation-phase-four-project"),
    title: "Dictation fence",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    checkpoints: [],
    pullRequests: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    activities: [],
  } as unknown as Thread;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.thread = makeThread();
  fixture.dictationCalls.length = 0;
  fixture.uploads.length = 0;
  fixture.jobs = [];
  fixture.jobsLoaded = true;
  fixture.dictationCommands = new Map<unknown, string>([
    [dictationEnvironment.start, "start"],
    [dictationEnvironment.retry, "retry"],
    [dictationEnvironment.cancel, "cancel"],
    [dictationEnvironment.setMode, "setMode"],
    [threadEnvironment.startTurn, "startTurn"],
  ]);
  fixture.readPromptAtUpload = () => promptOf(onScreenTarget);
  media = createFakeMedia();
  setDictationMediaBackend(media.backend);
  writeText = vi.fn(async (_text: string) => undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  vi.spyOn(toastManager, "add");
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  setDictationMediaBackend(null);
  useComposerDraftStore.getState().clearComposerContent(onScreenTarget);
  useComposerDraftStore.getState().clearComposerContent(offScreenTarget);
  Reflect.deleteProperty(navigator, "clipboard");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

let router: ReturnType<typeof createRouter> | undefined;

/** The modules an app mount is built from; a reload passes freshly imported ones. */
interface AppModules {
  readonly AppRoot: typeof AppRoot;
  readonly AppSidebarLayout: typeof AppSidebarLayout;
  readonly ChatView: typeof ChatView;
  readonly createRootRoute: typeof createRootRoute;
  readonly createRoute: typeof createRoute;
  readonly createRouter: typeof createRouter;
  readonly createMemoryHistory: typeof createMemoryHistory;
  readonly Outlet: typeof Outlet;
}

async function mountApp(
  modules: AppModules = {
    AppRoot,
    AppSidebarLayout,
    ChatView,
    createRootRoute,
    createRoute,
    createRouter,
    createMemoryHistory,
    Outlet,
  },
) {
  const {
    AppRoot,
    AppSidebarLayout,
    ChatView,
    createRootRoute,
    createRoute,
    createRouter,
    createMemoryHistory,
    Outlet,
  } = modules;
  const route = createRootRoute({
    component: () => (
      <AppSidebarLayout>
        <Outlet />
      </AppSidebarLayout>
    ),
  });
  const index = createRoute({
    getParentRoute: () => route,
    path: "/",
    component: () => (
      <ChatView environmentId={environmentId} threadId={threadId} routeKind="server" />
    ),
  });
  // A page without the thread, so its composer is not on screen.
  const elsewhere = createRoute({
    getParentRoute: () => route,
    path: "/elsewhere",
    component: () => <p>Elsewhere</p>,
  });
  router = createRouter({
    routeTree: route.addChildren([index, elsewhere]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  await act(async () => {
    root = createRoot(container);
    root.render(<AppRoot router={router as unknown as AppRouter} />);
  });
}

/**
 * A page reload: the app unmounts, every module starts over and reads storage again, and the
 * server's job list is empty until its snapshot arrives, as a fresh subscription's is.
 */
async function reloadApp() {
  await act(async () => root?.unmount());
  root = undefined;
  vi.resetModules();
  const router = await import("@tanstack/react-router");
  const freshCommands = (await import("./state/dictation")).dictationEnvironment;
  fixture.dictationCommands.set(freshCommands.start, "start");
  fixture.dictationCommands.set(freshCommands.setMode, "setMode");
  await act(async () => {
    fixture.jobs = [];
    fixture.jobsLoaded = false;
    for (const listener of fixture.jobListeners) listener();
  });
  await mountApp({
    AppRoot: (await import("./AppRoot")).AppRoot,
    AppSidebarLayout: (await import("./components/AppSidebarLayout")).AppSidebarLayout,
    ChatView: (await import("./components/ChatView")).default,
    createRootRoute: router.createRootRoute,
    createRoute: router.createRoute,
    createRouter: router.createRouter,
    createMemoryHistory: router.createMemoryHistory,
    Outlet: router.Outlet,
  });
  await settle();
}

async function navigateAwayFromThread() {
  await act(async () => {
    await router!.navigate({ to: "/elsewhere" as never });
  });
  await settle();
  expect(container.querySelector('[data-lexical-editor="true"]')).toBeNull();
}

/** Lets promise chains (getUserMedia, Blob reads, upload, start) settle inside React's act. */
async function settle() {
  await act(async () => {
    for (let round = 0; round < 10; round += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  });
}

function promptOf(target: typeof onScreenTarget): string | null {
  return useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? null;
}

function buttonLabelled(label: string | RegExp): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => {
    const name = button.getAttribute("aria-label") ?? button.textContent ?? "";
    return typeof label === "string" ? name === label : label.test(name);
  });
}

function requireButton(label: string | RegExp): HTMLButtonElement {
  const button = buttonLabelled(label);
  expect(
    button,
    `Expected a button labelled ${String(label)}; buttons: ${[
      ...document.querySelectorAll("button"),
    ]
      .map((entry) => entry.getAttribute("aria-label") ?? entry.textContent)
      .join(" | ")}`,
  ).toBeDefined();
  return button!;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await settle();
}

/** The microphone in the composer: the same control the Shell path labels "Start voice dictation". */
async function startRecordingFromMicrophone() {
  const microphone = requireButton("Start voice dictation");
  expect(microphone.getAttribute("aria-disabled")).not.toBe("true");
  await click(microphone);
}

async function stopRecordingFromStrip() {
  await click(requireButton("Stop and transcribe"));
}

async function pressKey(init: KeyboardEventInit & { key: string }, target?: Element | null) {
  const element = target ?? document.activeElement ?? document.body;
  // happy-dom reports AltGraph whenever Alt is held; a browser on Linux reports it only for
  // the right Alt key, so the left Alt chords here behave as they do in the app.
  const keyEvent = (type: string) => {
    const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
    const original = event.getModifierState.bind(event);
    Object.defineProperty(event, "getModifierState", {
      value: (key: string) => (key === "AltGraph" ? false : original(key)),
    });
    return event;
  };
  await act(async () => {
    element.dispatchEvent(keyEvent("keydown"));
    element.dispatchEvent(keyEvent("keyup"));
  });
  await settle();
}

const altKey = (key: string, code: string) => ({ key, code, altKey: true });
const ALT_S = altKey("s", "KeyS");
const ALT_I = altKey("i", "KeyI");
const ALT_ENTER = altKey("Enter", "Enter");
const TOGGLE = { key: "d", code: "KeyD", ctrlKey: true, altKey: true };

function composerEditorElement(): HTMLElement {
  const editor = container.querySelector<HTMLElement>('[data-lexical-editor="true"]');
  expect(editor, "Expected the composer editor").not.toBeNull();
  return editor!;
}

function lexicalEditor(): LexicalEditor {
  const editor = (composerEditorElement() as unknown as { __lexicalEditor?: LexicalEditor })
    .__lexicalEditor;
  expect(editor, "Expected the Lexical editor on the composer element").toBeDefined();
  return editor!;
}

/** Puts the composer's caret right after `before` in the text node that contains it. */
async function placeCaretAfter(before: string) {
  const editor = lexicalEditor();
  await act(async () => {
    editor.update(
      () => {
        const nodes = $getRoot().getAllTextNodes();
        for (const node of nodes) {
          const offset = node.getTextContent().indexOf(before);
          if (offset >= 0) {
            node.select(offset + before.length, offset + before.length);
            return;
          }
        }
        throw new Error(`No text node holds ${before}`);
      },
      { discrete: true },
    );
  });
  expect(textBeforeCaret(), "the fixture placed the caret").toMatch(new RegExp(`${before}$`));
}

/** The composer's text up to the caret, counting text nodes only (a marker chip has none). */
function textBeforeCaret(): string {
  return lexicalEditor()
    .getEditorState()
    .read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return "<no caret>";
      const anchor = selection.anchor.getNode();
      let text = "";
      for (const node of $getRoot().getAllTextNodes()) {
        if (node.is(anchor) && $isTextNode(anchor)) {
          return text + (anchor as TextNode).getTextContent().slice(0, selection.anchor.offset);
        }
        text += node.getTextContent();
      }
      return "<caret outside text>";
    });
}

function startCalls() {
  return fixture.dictationCalls.filter((call) => call.name === "start");
}

function setModeCalls() {
  return fixture.dictationCalls.filter((call) => call.name === "setMode");
}

function startedJob(index: number) {
  const call = startCalls()[index];
  expect(call, `Expected dictation start #${index + 1}`).toBeDefined();
  return call!.value as {
    environmentId: string;
    input: {
      jobId: string;
      attachmentId: string;
      durationMs: number;
      mode: DictationMode;
      target: DictationTarget;
    };
  };
}

function job(
  id: string,
  overrides: Partial<Omit<DictationJob, "id">> & Pick<DictationJob, "status">,
): DictationJob {
  return {
    id: DictationJobId.make(id),
    target: { kind: "thread", environmentId, threadId },
    mode: "inject",
    durationMs: 4_000,
    createdAt: now,
    ...overrides,
  };
}

async function pushJobs(jobs: ReadonlyArray<DictationJob>) {
  await act(async () => {
    fixture.jobs = [...jobs];
    fixture.jobsLoaded = true;
    for (const listener of fixture.jobListeners) listener();
  });
  await settle();
}

function transcriptionsNotices() {
  return vi
    .mocked(toastManager.add)
    .mock.calls.map(([toast]) => `${String(toast.title ?? "")} ${String(toast.description ?? "")}`)
    .filter((text) => /transcriptions/i.test(text));
}

/** Marker insertion may leave one or two spaces; the criteria are about order, not spacing. */
function squash(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function slotsIn(prompt: string | null) {
  return findDictationSlots(prompt ?? "");
}

// ── Specs ───────────────────────────────────────────────────────────────────

describe("dictation phase 4 fence", () => {
  it("dictation phase 4 AC1: the microphone button and the toggle command record with MediaRecorder behind the shipped strip controls", async () => {
    await mountApp();

    await startRecordingFromMicrophone();
    expect(media.constraints).toHaveLength(1);
    expect(media.constraints[0]).toEqual(expect.objectContaining({ audio: expect.anything() }));
    expect(media.recorders).toHaveLength(1);
    expect(media.recorders[0]!.options).toMatchObject({
      mimeType: "audio/webm;codecs=opus",
      audioBitsPerSecond: 32_000,
    });
    expect(media.recorders[0]!.calls).toContain("start");
    // The shipped DictationStripBanner controls.
    for (const label of [
      "Pause recording",
      "Restart recording",
      "Cancel dictation",
      "Stop and transcribe",
      "Delivery mode: submit",
    ]) {
      requireButton(label);
    }

    await click(requireButton("Pause recording"));
    expect(media.recorders[0]!.state).toBe("paused");
    await click(requireButton("Resume recording"));
    expect(media.recorders[0]!.state).toBe("recording");

    await click(requireButton("Cancel dictation"));
    expect(buttonLabelled("Stop and transcribe")).toBeUndefined();
    expect(fixture.uploads).toHaveLength(0);
    expect(startCalls()).toHaveLength(0);

    // The toggle command starts a recording, and the same command stops it.
    await pressKey(TOGGLE);
    expect(media.recorders).toHaveLength(2);
    expect(media.recorders[1]!.calls).toContain("start");
    requireButton("Stop and transcribe");
    await pressKey(TOGGLE);
    expect(media.recorders[1]!.calls).toContain("stop");
    expect(buttonLabelled("Stop and transcribe")).toBeUndefined();
    expect(startCalls()).toHaveLength(1);
  });

  it("dictation phase 4 AC2: Alt+S, Alt+I and Alt+Enter select the mode while recording and while the last job transcribes", async () => {
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Keep this draft");
    await mountApp();

    await startRecordingFromMicrophone();
    await pressKey(ALT_S);
    requireButton("Delivery mode: clipboard");
    await pressKey(ALT_I);
    requireButton("Delivery mode: inject");
    await stopRecordingFromStrip();
    const started = startedJob(0);
    expect(started.input.mode).toBe("inject");
    const jobId = started.input.jobId;

    // The last stopped job is still transcribing: the keys reach it through setMode.
    await pushJobs([job(jobId, { status: "transcribing", mode: "inject" })]);
    const editor = composerEditorElement();
    await pressKey(ALT_ENTER, editor);
    // Alt+Enter selected a mode; it did not send or clear the draft.
    expect(promptOf(onScreenTarget)).toContain("Keep this draft");
    expect(slotsIn(promptOf(onScreenTarget))).toHaveLength(1);
    await pressKey(ALT_S);
    expect(setModeCalls().map((call) => call.value)).toEqual([
      { environmentId, input: { jobId, mode: "submit" } },
      { environmentId, input: { jobId, mode: "clipboard" } },
    ]);
    // Save takes the stopped job's marker out of the draft at once.
    expect(promptOf(onScreenTarget)).toContain("Keep this draft");
    expect(slotsIn(promptOf(onScreenTarget))).toHaveLength(0);

    // Once the last job has completed, the keys select nothing.
    await pushJobs([job(jobId, { status: "completed", mode: "clipboard", text: "done" })]);
    await pressKey(ALT_I);
    expect(setModeCalls()).toHaveLength(2);
  });

  it("dictation phase 4 AC3: stopping drops the marker at the composer caret, then uploads and starts the job", async () => {
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Hello world");
    await mountApp();
    await placeCaretAfter("Hello");

    await startRecordingFromMicrophone();
    await stopRecordingFromStrip();

    const prompt = promptOf(onScreenTarget)!;
    const [slot, ...others] = slotsIn(prompt);
    expect(slot, `Expected one marker in ${JSON.stringify(prompt)}`).toBeDefined();
    expect(others).toHaveLength(0);
    expect(prompt.slice(0, slot!.start).trimEnd()).toBe("Hello");
    expect(prompt.slice(slot!.end).trimStart()).toBe("world");

    // Marker first, then the upload, then the job, all for the same id.
    expect(fixture.uploads).toHaveLength(1);
    expect(slotsIn(fixture.uploads[0]!.promptAtUpload).map((entry) => entry.jobId)).toEqual([
      slot!.jobId,
    ]);
    expect(fixture.uploads[0]!.upload).toMatchObject({
      type: "file",
      mimeType: expect.stringMatching(/^audio\/webm/),
      sizeBytes: 7,
    });
    expect(startedJob(0)).toEqual({
      environmentId,
      input: {
        jobId: slot!.jobId,
        attachmentId: "dictation-audio-1",
        durationMs: expect.any(Number),
        mode: "submit",
        target: { kind: "thread", environmentId, threadId },
      },
    });
    // The microphone is released and the strip goes away once recording stops.
    expect(media.stoppedTracks).toEqual([1]);
    expect(buttonLabelled("Stop and transcribe")).toBeUndefined();
  });

  it("dictation phase 4 AC3: a composer without a caret gets the marker at the end", async () => {
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Existing draft");
    await mountApp();
    // No caret: the editor holds no selection at all.
    await act(async () => {
      lexicalEditor().update(() => $setSelection(null), { discrete: true });
    });
    expect(textBeforeCaret()).toBe("<no caret>");

    await startRecordingFromMicrophone();
    await stopRecordingFromStrip();

    const prompt = promptOf(onScreenTarget)!;
    const [slot] = slotsIn(prompt);
    expect(slot, `Expected a marker in ${JSON.stringify(prompt)}`).toBeDefined();
    expect(prompt.slice(0, slot!.start).trimEnd()).toBe("Existing draft");
    expect(prompt.slice(slot!.end).trim()).toBe("");
    expect(startCalls()).toHaveLength(1);
  });

  it("dictation phase 4 AC4: the marker draws six stepped wave bars and the mode icon, and holds still under reduced motion", async () => {
    await mountApp();
    await startRecordingFromMicrophone();
    await stopRecordingFromStrip();
    const { jobId } = startedJob(0).input;
    await pushJobs([job(jobId, { status: "transcribing", mode: "submit" })]);

    const editor = composerEditorElement();
    const waves = editor.querySelectorAll('[aria-label="Transcribing"]');
    expect(waves, `Expected one marker wave; composer: ${editor.innerHTML}`).toHaveLength(1);
    expect(waves[0]!.children).toHaveLength(6);
    const chip = waves[0]!.parentElement!;
    expect(chip.querySelector('svg[data-material-symbol="send"]')).not.toBeNull();

    // The motion itself lives in the stylesheet: `dictation/dictationSlot.test.ts` pins it.
    expect(chip.classList.contains("dictation-slot")).toBe(true);
    expect(waves[0]!.classList.contains("dictation-slot-wave")).toBe(true);
  });

  it("dictation phase 4 AC5: a completed job replaces its marker on screen and in a draft that is not on screen", async () => {
    // A marker this client did not drop: another device's job, which only that device fills.
    const foreignJobId = "6f1c2a9e-0d3b-4c8e-9a51-2b7d4e8f0a13";
    const foreignDraft = `Before ${formatDictationSlot(DictationJobId.make(foreignJobId))} after`;
    useComposerDraftStore.getState().setPrompt(offScreenTarget, foreignDraft);
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Hello big world");
    await mountApp();
    await placeCaretAfter("Hello");
    await startRecordingFromMicrophone();
    await stopRecordingFromStrip();
    const first = startedJob(0).input.jobId;

    // The user moved on and dictated again after "big", past the first marker.
    await placeCaretAfter("big");
    await startRecordingFromMicrophone();
    await stopRecordingFromStrip();
    const second = startedJob(1).input.jobId;
    expect(slotsIn(promptOf(onScreenTarget)).map((slot) => slot.jobId)).toEqual([first, second]);

    // On screen: the transcript replaces its marker and the caret stays after the second one.
    const foreignJob = job(foreignJobId, {
      status: "completed",
      text: "desde otro dispositivo",
      target: { kind: "thread", environmentId, threadId: offScreenThreadId },
    });
    await pushJobs([job(first, { status: "completed", text: "hola mundo" }), foreignJob]);
    expect(squash(promptOf(onScreenTarget)).replace(/\[Transcribing\]\([^)]*\)/, "<m>")).toBe(
      "Hello hola mundo big <m> world",
    );
    expect(squash(composerEditorElement().textContent)).toContain("Hello hola mundo big");
    expect(squash(textBeforeCaret())).toBe("Hello hola mundo big");

    // Not on screen: the thread's composer is gone and the draft is still filled.
    await navigateAwayFromThread();
    await pushJobs([
      job(first, { status: "completed", text: "hola mundo" }),
      job(second, { status: "completed", text: "desde lejos" }),
      foreignJob,
    ]);
    expect(squash(promptOf(onScreenTarget))).toBe("Hello hola mundo big desde lejos world");
    expect(promptOf(offScreenTarget)).toBe(foreignDraft);

    // A job is filled once: the same completed jobs arriving again change nothing.
    await pushJobs([
      job(first, { status: "completed", text: "hola mundo" }),
      job(second, { status: "completed", text: "desde lejos" }),
      foreignJob,
    ]);
    expect(squash(promptOf(onScreenTarget))).toBe("Hello hola mundo big desde lejos world");
    expect(promptOf(offScreenTarget)).toBe(foreignDraft);
    expect(transcriptionsNotices()).toEqual([]);
  });

  it("dictation phase 4 AC6: a completed job whose marker was deleted keeps its text in the Transcriptions list with one notice", async () => {
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Draft");
    await mountApp();
    await startRecordingFromMicrophone();
    await stopRecordingFromStrip();
    const { jobId } = startedJob(0).input;
    await pushJobs([job(jobId, { status: "transcribing" })]);

    // The user deletes the marker.
    await act(async () => {
      useComposerDraftStore.getState().setPrompt(onScreenTarget, "Draft edited");
    });
    await settle();

    await pushJobs([job(jobId, { status: "completed", text: "texto perdido" })]);
    expect(promptOf(onScreenTarget)).toBe("Draft edited");
    expect(transcriptionsNotices()).toHaveLength(1);

    await pushJobs([job(jobId, { status: "completed", text: "texto perdido" })]);
    expect(transcriptionsNotices()).toHaveLength(1);
  });

  it("dictation phase 4 AC7: save mode drops no marker and copies the text when it arrives", async () => {
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Untouched");
    await mountApp();
    await startRecordingFromMicrophone();
    await pressKey(ALT_S);
    await stopRecordingFromStrip();

    expect(promptOf(onScreenTarget)).toBe("Untouched");
    const started = startedJob(0);
    expect(started.input).toMatchObject({ mode: "clipboard", target: null });
    expect(fixture.uploads).toHaveLength(1);
    expect(writeText).not.toHaveBeenCalled();

    await pushJobs([
      job(started.input.jobId, {
        status: "completed",
        mode: "clipboard",
        target: null,
        text: "para el portapapeles",
      }),
    ]);
    expect(writeText).toHaveBeenCalledExactlyOnceWith("para el portapapeles");
    expect(promptOf(onScreenTarget)).toBe("Untouched");
    expect(transcriptionsNotices()).toEqual([]);
  });

  it("dictation phase 4 AC8: a second recording starts while the first job is still transcribing", async () => {
    await mountApp();
    await startRecordingFromMicrophone();
    await stopRecordingFromStrip();
    const first = startedJob(0).input.jobId;
    await pushJobs([job(first, { status: "transcribing", mode: "submit" })]);

    await startRecordingFromMicrophone();
    expect(media.recorders).toHaveLength(2);
    requireButton("Stop and transcribe");
    await stopRecordingFromStrip();

    const second = startedJob(1).input.jobId;
    expect(second).not.toBe(first);
    expect(fixture.uploads).toHaveLength(2);
    expect(slotsIn(promptOf(onScreenTarget)).map((slot) => slot.jobId)).toEqual(
      expect.arrayContaining([first, second]),
    );
    expect(slotsIn(promptOf(onScreenTarget))).toHaveLength(2);
  });
});

describe("dictation phase 4 regressions", () => {
  it("dictation phase 4 regression: after a page reload the mode keys steer the job that is still transcribing", async () => {
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Before the reload");
    await mountApp();
    await startRecordingFromMicrophone();
    await stopRecordingFromStrip();
    const { jobId } = startedJob(0).input;
    expect(persistComposerDrafts()).toBe(true);

    await reloadApp();
    // The subscription's snapshot arrives after the app is up, with the job still transcribing.
    await pushJobs([job(jobId, { status: "transcribing", mode: "submit" })]);
    await pressKey(ALT_I);
    await pressKey(ALT_S);
    expect(setModeCalls().map((call) => call.value)).toEqual([
      { environmentId, input: { jobId, mode: "inject" } },
      { environmentId, input: { jobId, mode: "clipboard" } },
    ]);
  });

  it("dictation phase 4 regression: two transcripts landing together keep the caret where the user left it", async () => {
    useComposerDraftStore.getState().setPrompt(onScreenTarget, "Hello big world");
    await mountApp();
    await placeCaretAfter("Hello");
    await startRecordingFromMicrophone();
    await stopRecordingFromStrip();
    await placeCaretAfter("world");
    await startRecordingFromMicrophone();
    await stopRecordingFromStrip();
    const [first, second] = [startedJob(0).input.jobId, startedJob(1).input.jobId];
    // The user goes back between the two markers.
    await placeCaretAfter("big");

    await pushJobs([
      job(first, { status: "completed", text: "hola mundo" }),
      job(second, { status: "completed", text: "y adios" }),
    ]);
    expect(squash(promptOf(onScreenTarget))).toBe("Hello hola mundo big world y adios");
    expect(squash(textBeforeCaret())).toBe("Hello hola mundo big");
  });
});

describe("dictation phase 4 guards", () => {
  it("dictation phase 4 guard: typing into the composer and pressing Send still starts a turn with the text", async () => {
    await mountApp();
    const editor = composerEditorElement();
    await act(async () => {
      editor.focus();
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "Ship the dictation fence");
      editor.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
      );
    });
    await settle();
    expect(promptOf(onScreenTarget)).toBe("Ship the dictation fence");

    const sendButton = requireButton("Send message");
    await click(sendButton);
    const turns = fixture.dictationCalls.filter((call) => call.name === "startTurn");
    expect(turns).toHaveLength(1);
    expect(JSON.stringify(turns[0]!.value)).toContain("Ship the dictation fence");
    expect(fixture.uploads).toHaveLength(0);
    expect(startCalls()).toHaveLength(0);
  });
});
