import { act, type Screen } from "../test/render";
import { page } from "vite-plus/test/browser";
import { flushBrowserTasks } from "./test/browserTasks";
// Editor latency: keys in the real file panel (Monaco, Neovim over `test/nvimEditorHarness.tsx`)
// must not re-render `SidebarThreadRow` or `TooltipTrigger` in the real Sidebar. Control chords
// did, through `useShortcutModifierState`; shell updates did, through a new `sortable` bag on each
// sidebar render. The fixture is `test/appRootFenceMocks.tsx` without its sidebar stub.
import { type ReactNode } from "react";
import * as monaco from "monaco-editor";
import { PromiseClipboardItem } from "./test/promiseClipboardItem";
import { describe, expect, it, vi } from "vite-plus/test";

// Before anything imports react-dom: the commit counter is React's DevTools hook.
const commitCounter = await vi.hoisted(async () =>
  (await import("./test/reactCommitCounter")).installReactCommitCounter(),
);

// happy-dom has no canvas: only the overview ruler's painting is replaced, as
// in `AppRoot.panelSurfaceEntry.fence.test.tsx`.
vi.mock(
  "monaco-editor/editor/browser/viewParts/overviewRuler/decorationsOverviewRuler.js",
  async (original) => {
    const actual = await original<{
      DecorationsOverviewRuler: new (...args: unknown[]) => { _render(): void };
    }>();
    return {
      ...actual,
      DecorationsOverviewRuler: class extends actual.DecorationsOverviewRuler {
        override _render(): void {}
      },
    };
  },
);

const fenceMocks = vi.hoisted(() => () => import("./test/appRootFenceMocks"));
vi.mock("./state/presentation", async (original) =>
  (await fenceMocks()).mockPresentation(original),
);
const nvimHarness = vi.hoisted(() => () => import("./test/nvimEditorHarness"));
// Neovim's side of the editor session: every `editorSession.*` call reaches
// the harness's transport, which answers it and streams what the test emits.
vi.mock("./connection/runtime", async (original) => ({
  ...(await original<typeof import("./connection/runtime")>()),
  connectionAtomRuntime: (await nvimHarness()).editorTransport.runtime,
}));
vi.mock("@t3tools/client-runtime/state/session", async (original) =>
  (await fenceMocks()).mockRuntimeSession(original),
);
/**
 * What the sidebar lists. The shared fixture lists nothing, because its
 * sidebar is a stub; this fence fills both lists before mounting, and keeps
 * them the same arrays so a render reads the same value it read before.
 */
const sidebarLists = vi.hoisted(() => ({
  threads: [] as import("@t3tools/client-runtime/state/models").EnvironmentThreadShell[],
  projects: [] as unknown[],
  /** Readers of the thread list, told when a test replaces it (`updateThreadShell`). */
  listeners: new Set<() => void>(),
}));
vi.mock("./state/entities", async (original) => {
  const mocks = await fenceMocks();
  const { Atom } = await import("effect/reactivity");
  const { useAtomValue } = await import("@effect/atom-react");
  const { createEnvironmentThreadShellAtoms } =
    await import("@t3tools/client-runtime/state/threads");
  const { PrimaryConnectionTarget } = await import("@t3tools/client-runtime/connection");
  const { EnvironmentId } = await import("@t3tools/contracts");
  const Option = await import("effect/Option");
  const { environmentServerConfigsAtom } = await import("./state/server");
  const environmentId = EnvironmentId.make(mocks.FENCE_ENVIRONMENT_ID);
  const catalogValueAtom = Atom.make({
    isReady: true,
    entries: new Map([
      [
        environmentId,
        {
          enabled: true,
          profile: Option.none(),
          target: new PrimaryConnectionTarget({
            environmentId,
            label: "Editor fence",
            httpBaseUrl: "https://editor-fence.invalid",
            wsBaseUrl: "wss://editor-fence.invalid",
          }),
        },
      ],
    ]),
  });
  const snapshotAtom = Atom.family((id: typeof environmentId) =>
    Atom.make((get) => {
      const read = (): import("@t3tools/contracts").OrchestrationV2ShellSnapshot => ({
        schemaVersion: 1,
        snapshotSequence: 0,
        threads: sidebarLists.threads
          .filter((thread) => thread.environmentId === id)
          .map((thread) => thread.source),
        archivedThreads: [],
        projects: [],
      });
      const listener = () => get.setSelf(read());
      sidebarLists.listeners.add(listener);
      get.addFinalizer(() => sidebarLists.listeners.delete(listener));
      return read();
    }).pipe(Atom.setIdleTTL(0)),
  );
  // Keep the production quiet/live derivations in this render-cost fence.
  const shells = createEnvironmentThreadShellAtoms({ catalogValueAtom, snapshotAtom });
  const emptyShell = Atom.make(null);
  return {
    ...(await mocks.mockEntities(original)),
    useThreadShells: () => useAtomValue(shells.threadShellsAtom),
    useQuietThreadShells: () => useAtomValue(shells.quietThreadShellsAtom),
    useThreadShell: (ref: import("@t3tools/contracts").ScopedThreadRef | null) =>
      useAtomValue(ref === null ? emptyShell : shells.threadShellAtom(ref)),
    useQuietThreadShell: (ref: import("@t3tools/contracts").ScopedThreadRef | null) =>
      useAtomValue(ref === null ? emptyShell : shells.quietThreadShellAtom(ref)),
    useServerConfigs: () => useAtomValue(environmentServerConfigsAtom),
    useProjects: () => sidebarLists.projects,
  };
});
vi.mock("./state/environments", async (original) =>
  (await fenceMocks()).mockEnvironments(original),
);
vi.mock("./state/query", async (original) => (await fenceMocks()).mockQuery(original));
vi.mock("./state/queries", async (original) => (await fenceMocks()).mockQueries(original));
vi.mock("./state/threads", async (original) => (await fenceMocks()).mockThreads(original));
// The editor session's commands run for real, against the harness; every
// other command answers success, as in the shared fixture.
vi.mock("./state/use-atom-command", async (original) => {
  const actual = await original<typeof import("./state/use-atom-command")>();
  const fixtureCommand = (await fenceMocks()).mockAtomCommand().useAtomCommand;
  return {
    useAtomCommand: ((command: { readonly label: string }, options?: unknown) =>
      command.label.startsWith("environment-data:editor-session:")
        ? actual.useAtomCommand(command as never, options as never)
        : fixtureCommand()) as typeof actual.useAtomCommand,
  };
});
vi.mock("./state/use-atom-query-runner", async () => (await fenceMocks()).mockAtomQueryRunner());
// The thread capabilities a current host advertises. Rows are draggable only
// with pin reordering, and a draggable row is what the live sidebar renders:
// dnd-kit hands it listeners, which every sidebar render rebuilds.
vi.mock("./state/server", async (original) => {
  const mocks = await fenceMocks();
  const { Atom } = await import("effect/reactivity");
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  const [environment] = mocks.appRootFence.environments;
  const configs = new Map([
    [
      environment!.environmentId,
      {
        ...environment!.serverConfig,
        settings: DEFAULT_SERVER_SETTINGS,
        environment: {
          ...environment!.serverConfig.environment,
          capabilities: {
            ...environment!.serverConfig.environment.capabilities,
            threadSettlement: true,
            threadSnooze: true,
            threadPinning: true,
            threadPinReorder: true,
            threadActiveReorder: true,
          },
        },
      },
    ],
  ]);
  return {
    ...(await mocks.mockServer(original)),
    primaryServerKeybindingsAtom: Atom.make(await fenceKeybindings()),
    environmentServerConfigsAtom: Atom.make(configs),
  };
});
/**
 * The shipped chords plus `mod+1`…`mod+9` and `mod+0` for the thread jumps, as the
 * developer's keybindings file has them. The fork ships no jump binding, and
 * without one the sidebar shows no jump hints at all.
 */
const fenceKeybindings = vi.hoisted(() => async () => {
  const { compileResolvedKeybindingsConfig, DEFAULT_KEYBINDINGS } =
    await import("@t3tools/shared/keybindings");
  const { THREAD_JUMP_KEYBINDING_COMMANDS } = await import("@t3tools/contracts");
  return compileResolvedKeybindingsConfig([
    ...DEFAULT_KEYBINDINGS,
    ...THREAD_JUMP_KEYBINDING_COMMANDS.map((command, index) => ({
      key: `mod+${(index + 1) % 10}`,
      command,
    })),
  ]);
});
vi.mock("./hooks/useSettings", async (original) => (await fenceMocks()).mockSettings(original));
vi.mock("./hooks/useHandleNewThread", async () => (await fenceMocks()).mockHandleNewThread());
vi.mock("./hooks/useThreadActions", async () => (await fenceMocks()).mockThreadActions());
vi.mock("./components/LegacySidebar", async () =>
  (await fenceMocks()).mockRendersNothing("default"),
);
vi.mock("./components/preview/PreviewAutomationHosts", async () =>
  (await fenceMocks()).mockRendersNothing("PreviewAutomationHosts"),
);
vi.mock("./browser/ElectronBrowserHost", async () =>
  (await fenceMocks()).mockRendersNothing("ElectronBrowserHost"),
);
vi.mock("./components/QuitHoldOverlay", async () =>
  (await fenceMocks()).mockRendersNothing("QuitHoldOverlay"),
);
vi.mock("./components/chat/ChatHeader", async () =>
  (await fenceMocks()).mockRendersNothing("ChatHeader"),
);
vi.mock("./components/BranchToolbar", async () =>
  (await fenceMocks()).mockRendersNothing("BranchToolbar"),
);
vi.mock("./components/files/mesuraFileManager/MesuraFileManagerLayer", async () =>
  (await fenceMocks()).mockFileManagerLayer(),
);
vi.mock("./keys/highlights", async () => (await fenceMocks()).mockHighlights());
vi.mock("@legendapp/list/react", async () => (await fenceMocks()).mockLegendList());
const SOURCE_FILE = vi.hoisted(() => ({
  name: "index.ts",
  lines: Array.from({ length: 120 }, (_, index) => `export const value${index} = ${index};`),
}));
vi.mock("./components/files/projectFilesQueryState", async (original) => ({
  ...(await original<typeof import("./components/files/projectFilesQueryState")>()),
  useProjectEntriesQuery: () => ({
    data: { entries: [{ path: SOURCE_FILE.name, kind: "file" }], truncated: false },
    error: null,
    isPending: false,
    refresh: () => undefined,
  }),
  // The file picker's search: the project's one file, for any query.
  useProjectFilePickerQuery: (_environmentId: string, _cwd: string, query: string) => ({
    entries: [{ path: SOURCE_FILE.name, kind: "file" }],
    error: null,
    isPending: false,
    matchedQuery: query,
  }),
  useProjectFileQuery: (
    _environmentId: string,
    _cwd: string,
    relativePath: string | null,
    enabled = true,
  ) => ({
    data:
      relativePath !== null && enabled
        ? {
            relativePath,
            contents: SOURCE_FILE.lines.join("\n"),
            byteLength: 4096,
            truncated: false,
          }
        : null,
    error: null,
    isPending: false,
    refresh: () => undefined,
  }),
}));
vi.mock("./components/DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));

import { MessageId, RunId, type ThreadId } from "@t3tools/contracts";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import * as DateTime from "effect/DateTime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import { useFileTreeStore } from "./components/files/mesuraTree/fileTreeStore";
import { useFileSurfacePendingStore } from "./components/files/fileSurfacePendingStore";
import { monacoFileModelKey } from "./components/files/monaco/monacoFileModels";
import { shortcutLabelForCommand } from "./keybindings";
import { installKeyEngine } from "./keys/keyEngine";
import { isFileTreeFocused } from "./lib/focusTargets";
import { useRightPanelStore } from "./rightPanelStore";
import {
  addFenceThread,
  fenceEnvironmentId as environmentId,
  makeMessage,
  renderFenceApp,
} from "./test/appRootFenceApp";
import { appRootFence as fixture, makeFenceSession } from "./test/appRootFenceMocks";
import { editorTransport } from "./test/nvimEditorHarness";
import type { RenderedComponent } from "./test/reactCommitCounter";

const THREAD_COUNT = 6;

let root: Screen | undefined;
let container: HTMLDivElement;
const openedThreads: ThreadId[] = [];

async function setupBrowserFixture0() {
  const previousViewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1440, 900);
  installKeyEngine();
  await import("./components/files/FilePreviewPanel");

  editorTransport.reset();
  editorTransport.setSnapshot({
    relativePath: SOURCE_FILE.name,
    lines: SOURCE_FILE.lines,
    cursor: { line: 1, col: 1 },
    topline: 1,
  });
  // The editable surface needs a write grant.
  fixture.sessions.set(
    environmentId,
    makeFenceSession([
      "orchestration:read",
      "orchestration:operate",
      "filesystem:read",
      "filesystem:write",
    ]),
  );

  vi.stubGlobal("ClipboardItem", PromiseClipboardItem);
  useFileTreeStore.setState({ explorerOpen: true });
  container = document.createElement("div");
  // AppRoot normally mounts in #root, whose CSS gives it a definite height.
  container.style.cssText = "width: 100%; height: 100dvh;";
  document.body.append(container);

  return {
    async [Symbol.asyncDispose]() {
      editorTransport.autoReplyAll();
      await act(async () => root?.[Symbol.asyncDispose]());
      // The unmounted surface writes what it still had and then clears its flag;
      // let that finish here, so it cannot clear the next test's flag instead.
      await settle();
      useFileSurfacePendingStore.setState({ pendingByProject: new Map() });
      root = undefined;
      container.remove();
      for (const threadId of openedThreads.splice(0)) {
        useRightPanelStore.getState().removeThread(scopeThreadRef(environmentId, threadId));
      }
      fixture.threads.clear();
      fixture.threadStates.clear();
      sidebarLists.threads = [];
      sidebarLists.projects = [];
      window.localStorage.clear();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      await page.viewport(previousViewport.width, previousViewport.height);
    },
  };
}

/** Drains browser tasks and React work without advancing Monaco's clock. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await flushBrowserTasks();
    });
  }
}

interface Chord {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey?: boolean;
  readonly keyCode?: number;
}

/** Dispatches one keyboard event from the focused element, as the browser does. */
async function dispatch(type: "keydown" | "keyup", chord: Chord): Promise<void> {
  const event = new KeyboardEvent(type, { ...chord, bubbles: true, cancelable: true });
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
}

/** One key, down and up. */
async function tap(chord: Chord): Promise<void> {
  await dispatch("keydown", chord);
  await dispatch("keyup", chord);
  await settle();
}

/**
 * Control down, `letter` tapped, Control up: a quick chord, before the jump
 * hints' show delay. The held-modifier guard waits for the hints separately.
 */
async function controlChord(letter: string): Promise<void> {
  const control = { key: "Control", code: "ControlLeft", ctrlKey: true, keyCode: 17 };
  const chord = { key: letter, code: `Key${letter.toUpperCase()}`, ctrlKey: true };
  await dispatch("keydown", control);
  await dispatch("keydown", chord);
  await dispatch("keyup", chord);
  await dispatch("keyup", { ...control, ctrlKey: false });
  await settle();
}

const editorHasFocus = () =>
  document.activeElement?.closest("[data-monaco-file-surface]") !== null &&
  document.activeElement !== null;

/** A click on the editor's text: the pointer goes down and up there, and the caret takes focus. */
async function clickEditorText(): Promise<void> {
  const lines = container.querySelector<HTMLElement>("[data-monaco-file-surface] .view-line");
  expect(lines, "the editor shows its text").not.toBeNull();
  await page.elementLocator(lines!).click();
  await vi.waitFor(() => expect(editorHasFocus(), `focus is on ${describeFocus()}`).toBe(true));
  await editorTransport.waitUntil(() =>
    editorTransport.requests.every((request) => request.settled),
  );
  await settle();
}

function describeFocus(): string {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return String(active);
  const label = active.getAttribute("aria-label") ?? active.textContent?.trim().slice(0, 40);
  return `<${active.tagName.toLowerCase()} class="${active.className}"> ${label ?? ""}`;
}

/** Upstream's Working shelf, on by default, lists running threads and starts collapsed. */
function expandWorkingShelf(): void {
  window.localStorage.setItem("t3code:sidebar:working-expanded", "true");
}

/**
 * Mounts the app on the first of `THREAD_COUNT` threads, opens the source
 * file from the Files tree with `Space p f`, `j`, Enter, and clicks its text.
 * The actual panel can hand focus to the editor when the file tab mounts.
 */
async function mountWithEditorFocused({
  backgroundStreaming = false,
}: { readonly backgroundStreaming?: boolean } = {}): Promise<void> {
  const threads = Array.from({ length: THREAD_COUNT }, (_, index) => {
    const id = `editor-key-cost-${index + 1}`;
    const threadId = addFenceThread(id, `Editor key cost ${index + 1}`, [
      makeMessage(`${id}-assistant`, "assistant", "Done."),
    ]);
    openedThreads.push(threadId);
    return threadId;
  });
  if (backgroundStreaming) {
    const backgroundId = threads[3]!;
    const shell = fixture.threads.get(backgroundId)!;
    const runId = RunId.make("editor-cost-background-run");
    fixture.threads.set(
      backgroundId,
      presentThreadShell(environmentId, {
        ...shell.source,
        latestRunId: runId,
        activeRunId: runId,
        status: "running",
      }),
    );
  }
  sidebarLists.threads = [...fixture.threads.values()];
  sidebarLists.projects = [fixture.project];
  if (backgroundStreaming) expandWorkingShelf();
  ({ root } = await renderFenceApp(container, threads[0]!, { vimMode: true }));
  await expect.element(page.getByTestId("sidebar-row-card").first()).toBeInTheDocument();
  await settle();
  (document.activeElement as HTMLElement | null)?.blur?.();

  await tap({ key: " ", code: "Space" });
  await tap({ key: "p", code: "KeyP" });
  await tap({ key: "f", code: "KeyF" });
  await vi.waitFor(() => expect(isFileTreeFocused(), `focus is on ${describeFocus()}`).toBe(true));
  expect(isFileTreeFocused(), `focus is on ${describeFocus()}`).toBe(true);
  await tap({ key: "Home", code: "Home" });
  await tap({ key: "j", code: "KeyJ" });
  await tap({ key: "Enter", code: "Enter" });
  await editorTransport.waitUntil(() =>
    editorTransport.requests.some(
      (request) =>
        request.method === "open" && request.payload === SOURCE_FILE.name && request.settled,
    ),
  );
  await vi.waitFor(() =>
    expect(container.querySelector("[data-monaco-file-surface] .view-line")).not.toBeNull(),
  );
  await clickEditorText();
  expect(editorHasFocus(), `focus is on ${describeFocus()}`).toBe(true);
  // The driver opened the file in the session, so keys now go to Neovim.
  expect(
    editorTransport.requests.some(
      (request) => request.method === "open" && request.payload === SOURCE_FILE.name,
    ),
    "the modal editor opened the file in the session",
  ).toBe(true);
}

function countByName(rendered: ReadonlyArray<RenderedComponent>, name: string): number {
  return rendered.filter((component) => component.name === name).length;
}

/** Renders of `name` with no file panel component above them. */
function countOutsideFilePanel(rendered: ReadonlyArray<RenderedComponent>, name: string): number {
  return rendered.filter(
    (component) =>
      component.name === name &&
      !component.owners.includes("FilePreviewPanel") &&
      !component.owners.includes("MonacoFileSurface"),
  ).length;
}

describe("editor keys and the sidebar (phase 4, criterion 2)", () => {
  it("editor key sidebar cost guard: the real sidebar shows every thread's row", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    commitCounter.start();
    await mountWithEditorFocused();
    const rendered = commitCounter.stop();
    expect(countByName(rendered, "SidebarThreadRow")).toBeGreaterThanOrEqual(THREAD_COUNT);
  });

  it("background sync spec: a shell update for one thread re-renders that thread's row only", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountWithEditorFocused();
    await settle();
    const threads = sidebarLists.threads;
    const changed = threads[3]!;
    commitCounter.start();
    // A running thread's shell, as the shell stream delivers it every few
    // seconds: something on the row changed, its place in the list did not.
    sidebarLists.threads = threads.map((thread) =>
      thread === changed
        ? presentThreadShell(environmentId, {
            ...thread.source,
            title: "Editor key cost 4, retitled by its agent",
          })
        : thread,
    );
    await act(async () => {
      for (const listener of sidebarLists.listeners) listener();
    });
    await settle();
    const rendered = commitCounter.stop();
    expect(countByName(rendered, "SidebarThreadRow"), "rows re-rendered").toBe(1);
    // The drag wrapper around each row ran `useSortable` for every thread on
    // every shell update: 76 wrappers per update in the S8 bench (phase 6).
    expect(countByName(rendered, "SortableThreadRow"), "row drag wrappers re-rendered").toBe(1);
  });

  it("background sync spec: a streaming tick updates its row without re-rendering Sidebar", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountWithEditorFocused({ backgroundStreaming: true });
    await settle();
    const background = sidebarLists.threads[3]!;
    expect(background.runtime?.status, "precondition: the background thread is running").toBe(
      "running",
    );
    const at = DateTime.add(background.source.updatedAt, { seconds: 1 });
    const streamed = presentThreadShell(environmentId, {
      ...background.source,
      updatedAt: at,
      itemCount: background.source.itemCount + 1,
      visibleItemCount: background.source.visibleItemCount + 1,
      latestVisibleMessage: {
        id: MessageId.make("editor-cost-background-stream"),
        role: "assistant",
        text: "The background agent is streaming.",
        updatedAt: at,
      },
    });
    commitCounter.start();
    sidebarLists.threads = sidebarLists.threads.map((thread) =>
      thread === background ? streamed : thread,
    );
    await act(async () => {
      for (const listener of Array.from(sidebarLists.listeners)) listener();
    });
    await settle();
    const rendered = commitCounter.stop();
    expect(
      {
        Sidebar: countByName(rendered, "Sidebar"),
        // A running thread's row sits in the Working section, outside the sortable items.
        rowWrapper:
          countByName(rendered, "SortableThreadRow") + countByName(rendered, "UnsortableThreadRow"),
        UnsortableThreadRow: countByName(rendered, "UnsortableThreadRow"),
        SidebarThreadRow: countByName(rendered, "SidebarThreadRow"),
      },
      "renders for one background streaming tick",
    ).toEqual({
      Sidebar: 0,
      rowWrapper: 1,
      UnsortableThreadRow: 1,
      SidebarThreadRow: 1,
    });
    expect(editorHasFocus(), `focus is on ${describeFocus()}`).toBe(true);
  });

  it("editor key sidebar cost guard: plain normal and insert keys re-render no sidebar row", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountWithEditorFocused();

    commitCounter.start();
    for (const letter of ["j", "j", "k", "i", "x", "y"]) {
      await tap({ key: letter, code: `Key${letter.toUpperCase()}` });
    }
    await tap({ key: "Escape", code: "Escape", keyCode: 27 });
    await editorTransport.waitUntil(() => editorTransport.appliedKeys().includes("jjkixy"));
    await settle();
    const rendered = commitCounter.stop();

    expect(editorTransport.appliedKeys(), "the keys reached Neovim").toContain("jjkixy");
    expect(countByName(rendered, "SidebarThreadRow")).toBe(0);
    expect(countOutsideFilePanel(rendered, "TooltipTrigger")).toBe(0);
  });

  it("editor key sidebar cost spec: Ctrl-d and Ctrl-u in the editor re-render no sidebar row", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountWithEditorFocused();

    commitCounter.start();
    await controlChord("d");
    await controlChord("u");
    await editorTransport.waitUntil(() => editorTransport.appliedKeys().includes("<C-d><C-u>"));
    await settle();
    const rendered = commitCounter.stop();

    expect(editorTransport.appliedKeys(), "the chords reached Neovim").toContain("<C-d><C-u>");
    expect(
      {
        SidebarThreadRow: countByName(rendered, "SidebarThreadRow"),
        Sidebar: countByName(rendered, "Sidebar"),
        TooltipTriggerOutsideFilePanel: countOutsideFilePanel(rendered, "TooltipTrigger"),
      },
      "renders outside the file panel for two Control chords typed in the editor",
    ).toEqual({ SidebarThreadRow: 0, Sidebar: 0, TooltipTriggerOutsideFilePanel: 0 });
    // The one component that follows modifiers by design renders nothing; any
    // other render outside the file panel is a Control chord paying for
    // something it does not change.
    const { ThreadJumpHintModifierSync: _modifierLeaf, ...elsewhere } =
      rendersOutsideFilePanel(rendered);
    expect(elsewhere, "renders outside the file panel for two Control chords").toEqual({});
  });

  it("editor key sidebar cost guard: holding the jump modifier in the editor still shows the thread jump hints", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountWithEditorFocused();
    // As the sidebar labels its first row.
    const firstJumpLabel = shortcutLabelForCommand(await fenceKeybindings(), "thread.jump.1");
    expect(firstJumpLabel, "precondition: thread.jump.1 has a binding").toBeTruthy();
    const jumpHintsShown = () =>
      [...container.querySelectorAll("span[aria-hidden]")].some(
        (element) => element.textContent === firstJumpLabel,
      );
    const control = { key: "Control", code: "ControlLeft", ctrlKey: true, keyCode: 17 };

    await dispatch("keydown", control);
    await vi.waitFor(() =>
      expect(jumpHintsShown(), "the hints show while the modifier is held").toBe(true),
    );
    await settle();
    expect(jumpHintsShown(), "the hints show while the modifier is held").toBe(true);

    await dispatch("keyup", { ...control, ctrlKey: false });
    await settle();
    expect(jumpHintsShown(), "the hints go when it is released").toBe(false);
  });
});

/**
 * The file panel's own components. `FileSurfacePendingMarker` is the unsaved
 * dot on the file's tab: the one thing outside the panel's body that must
 * change when an edit starts or is saved.
 */
const FILE_PANEL_COMPONENTS = new Set([
  "FilePreviewPanel",
  "MonacoFileSurface",
  "FileSurfacePendingMarker",
]);

/** Every render outside the file panel, counted by component name. */
function rendersOutsideFilePanel(
  rendered: ReadonlyArray<RenderedComponent>,
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const component of rendered) {
    const inPanel = [component.name, ...component.owners].some((name) =>
      FILE_PANEL_COMPONENTS.has(name),
    );
    if (inPanel) continue;
    counts[component.name] = (counts[component.name] ?? 0) + 1;
  }
  return counts;
}

/** The unsaved dot on the open file's tab in the panel's tab strip. */
function unsavedDotShown(): boolean {
  return (
    container.querySelector(
      "[data-right-panel-tab-list] span.rounded-full.bg-current[aria-hidden]",
    ) !== null
  );
}

describe("the first edit of a typing burst (phase 4, criterion 2)", () => {
  /** Line 1 as Neovim holds it, one typed character at a time. */
  let firstLine = SOURCE_FILE.lines[0]!;

  /**
   * Types `character` in insert mode and answers as Neovim does: the line
   * with the character prepended, then the cursor after it.
   */
  async function typeInInsertMode(character: string): Promise<void> {
    await tap({ key: character, code: `Key${character.toUpperCase()}` });
    firstLine = `${character}${firstLine}`;
    await act(async () => {
      editorTransport.emit(
        {
          type: "lines",
          relativePath: SOURCE_FILE.name,
          first: 0,
          last: 1,
          lines: [firstLine],
        },
        { type: "cursor", line: 1, col: 2 },
      );
    });
    await vi.waitFor(() => {
      const model = monaco.editor.getModel(
        monaco.Uri.parse(
          monacoFileModelKey(environmentId, fixture.project.workspaceRoot, SOURCE_FILE.name),
        ),
      );
      expect(model?.getLineContent(1), "the real Monaco model received Neovim's edited line").toBe(
        firstLine,
      );
    });
    await settle();
  }

  async function enterInsertMode(): Promise<void> {
    editorTransport.setNeovimMode({ mode: "i" });
    await tap({ key: "i", code: "KeyI" });
    await act(async () => {
      editorTransport.emit({ type: "mode", mode: "i", blocking: false });
    });
    await vi.waitFor(() =>
      expect(container.querySelector("[data-nvim-status-strip]")?.textContent).toContain("INSERT"),
    );
    await settle();
  }

  async function setupBrowserFixture1() {
    firstLine = SOURCE_FILE.lines[0]!;

    return { async [Symbol.asyncDispose]() {} };
  }

  it("editor key sidebar cost spec: the first insert-mode character after a clean open re-renders nothing outside the file panel", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await using _browserFixture1 = await setupBrowserFixture1();

    await mountWithEditorFocused();
    await enterInsertMode();

    commitCounter.start();
    await typeInInsertMode("x");
    const rendered = commitCounter.stop();

    expect(
      rendered.some((component) => component.name === "MonacoFileSurface"),
      "precondition: the edit reached the editor surface",
    ).toBe(true);
    expect(rendersOutsideFilePanel(rendered)).toEqual({});
    expect(unsavedDotShown(), "the file's tab shows its unsaved dot").toBe(true);
  });

  it("editor key sidebar cost spec: later characters of one typing burst leave the unsaved dot alone", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await using _browserFixture1 = await setupBrowserFixture1();

    await mountWithEditorFocused();
    await enterInsertMode();
    // Characters no other test types: the editor's models outlive a test, and
    // text the model already holds is no edit at all.
    await typeInInsertMode("w");
    expect(unsavedDotShown(), "precondition: the first character showed the unsaved dot").toBe(
      true,
    );

    // Typed inside the autosave's debounce, as a burst is: the dot is already
    // shown and stays shown, so nothing about it has to render.
    commitCounter.start();
    await typeInInsertMode("u");
    await typeInInsertMode("v");
    const rendered = commitCounter.stop();

    expect(
      countByName(rendered, "FileSurfacePendingMarker"),
      "marker renders for two later characters",
    ).toBe(0);
    expect(rendersOutsideFilePanel(rendered)).toEqual({});
    expect(unsavedDotShown()).toBe(true);
  });

  it("editor key sidebar cost spec: the first character after a save completed re-renders nothing outside the file panel", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await using _browserFixture1 = await setupBrowserFixture1();

    await mountWithEditorFocused();
    await enterInsertMode();
    await typeInInsertMode("x");
    await vi.waitFor(() =>
      expect(unsavedDotShown(), "the save confirmed and cleared the pending marker").toBe(false),
    );
    await settle();

    expect(unsavedDotShown(), "precondition: the save took the unsaved dot away").toBe(false);

    commitCounter.start();
    await typeInInsertMode("y");
    const rendered = commitCounter.stop();

    expect(rendersOutsideFilePanel(rendered)).toEqual({});
    expect(unsavedDotShown(), "the file's tab shows its unsaved dot again").toBe(true);
  });
});

describe("the first key after opening a file (phase 4, criterion 2)", () => {
  it("editor key sidebar cost spec: the first plain key after a file opened with Ctrl+P re-renders nothing outside the file panel", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await mountWithEditorFocused();
    // Open the file again the way the developer does: Ctrl+P from the editor,
    // its name, Enter. The picker hands the keyboard back to the editor.
    await controlChord("p");
    expect(
      document.querySelector('[data-testid="project-file-picker"]'),
      "precondition: Ctrl+P opened the file picker",
    ).not.toBeNull();
    const pickerInput = document.querySelector<HTMLInputElement>(
      '[data-testid="project-file-picker"] input',
    );
    expect(pickerInput, "the file picker search input is mounted").not.toBeNull();
    await page.elementLocator(pickerInput!).fill(SOURCE_FILE.name);
    expect(pickerInput!.value, "the browser entered the file name").toBe(SOURCE_FILE.name);
    await tap({ key: "Enter", code: "Enter" });
    await expect.element(page.getByTestId("project-file-picker")).not.toBeInTheDocument();
    // The picker leaves the keyboard in the composer; a click on the text puts
    // it back in the editor, as the verifier's driver and the developer do.
    await clickEditorText();
    await settle();
    expect(editorHasFocus(), `focus is on ${describeFocus()}`).toBe(true);

    commitCounter.start();
    await tap({ key: "j", code: "KeyJ" });
    await editorTransport.waitUntil(() => editorTransport.appliedKeys().endsWith("j"));
    await settle();
    const rendered = commitCounter.stop();

    expect(editorTransport.appliedKeys().endsWith("j"), "the key reached Neovim").toBe(true);
    expect(rendersOutsideFilePanel(rendered)).toEqual({});
  });
});

/** The status label in a row's top slot: the span holding the label as its own text. The phone's
 * sidebar sheet is portaled to the body, so the search covers the document. */
function rowStatusLabel(rowTitle: string, label: string): HTMLElement {
  const row = [...document.querySelectorAll<HTMLElement>('[data-testid="sidebar-row-card"]')].find(
    (candidate) => candidate.textContent?.includes(rowTitle),
  );
  expect(row, `a card row for ${rowTitle}`).toBeDefined();
  const slot = [...row!.querySelectorAll<HTMLElement>("span")].find((candidate) =>
    [...candidate.childNodes].some(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent === label,
    ),
  );
  expect(slot, `${rowTitle} shows ${label}; row reads ${row!.textContent}`).toBeDefined();
  // A working label's text sits in the Working section's band (workingSweep.tsx).
  return slot!.closest<HTMLElement>("[data-working-sweep]")?.parentElement ?? slot!;
}

/** The opacity a reader sees: the product of every ancestor's, up to the row's list item. */
function effectiveOpacity(element: HTMLElement): number {
  let opacity = 1;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    opacity *= Number(getComputedStyle(node).opacity);
    if (node.matches("[data-thread-item]")) break;
  }
  return opacity;
}

// Phase 3 of the thread attention cycle: no witness could produce a live Working row, so this
// mounts the real sidebar at Pixel 7 size with one running and one waiting thread.
describe("thread attention: Working and Waiting rows at phone width", () => {
  it("sidebar attention row spec: Working keeps its timer, has no icon and reads azure apart from Waiting at Pixel 7", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await page.viewport(412, 915);

    const [openId, workingId, waitingId] = [
      "attention-open",
      "attention-working",
      "attention-waiting",
    ].map((id, index) => {
      const threadId = addFenceThread(
        id,
        ["Opened thread", "Working thread", "Waiting thread"][index]!,
        [makeMessage(`${id}-assistant`, "assistant", "Done.")],
      );
      openedThreads.push(threadId);
      return threadId;
    });
    const workingShell = fixture.threads.get(workingId!)!;
    const workingRun = RunId.make("attention-working-run");
    fixture.threads.set(
      workingId!,
      presentThreadShell(environmentId, {
        ...workingShell.source,
        latestRunId: workingRun,
        activeRunId: workingRun,
        status: "running",
        latestRunStartedAt: DateTime.makeUnsafe("2026-10-08T11:55:00.000Z"),
      }),
    );
    const waitingShell = fixture.threads.get(waitingId!)!;
    fixture.threads.set(
      waitingId!,
      presentThreadShell(environmentId, {
        ...waitingShell.source,
        latestRunId: RunId.make("attention-waiting-run"),
        activeRunId: null,
        status: "completed",
        latestRunStartedAt: DateTime.makeUnsafe("2026-10-08T11:50:00.000Z"),
        latestRunCompletedAt: DateTime.makeUnsafe("2026-10-08T11:58:00.000Z"),
        pendingBackgroundTasks: [
          { taskId: "attention-command", description: "pnpm test", kind: "command" },
        ],
      }),
    );
    sidebarLists.threads = [...fixture.threads.values()];
    sidebarLists.projects = [fixture.project];
    expandWorkingShelf();
    ({ root } = await renderFenceApp(container, openId!, { vimMode: false }));
    await settle();
    // At phone width the sidebar is a sheet; the toggle chord opens it, as a keyboard would.
    // The composer takes focus on mount and claims Mod+B for bold, so the chord starts elsewhere.
    (document.activeElement as HTMLElement | null)?.blur?.();
    await dispatch("keydown", { key: "b", code: "KeyB", ctrlKey: true });
    await expect.element(page.getByTestId("sidebar-row-card").first()).toBeInTheDocument();
    await settle();

    const working = rowStatusLabel("Working thread", "Working");
    const waiting = rowStatusLabel("Waiting thread", "Waiting");
    expect(working.querySelector("svg"), "no Working icon").toBeNull();
    expect(waiting.querySelector("svg"), "no Waiting icon").toBeNull();
    const timer = working.querySelector(
      '[aria-hidden="true"] .tabular-nums, [aria-hidden] .tabular-nums',
    );
    expect(timer?.textContent ?? "", "the Working timer").toMatch(/\d/);

    const look = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      return {
        color: style.color,
        fontWeight: style.fontWeight,
        opacity: effectiveOpacity(element),
      };
    };
    // The developer's working-state prototype (2026-10-26) gave Working its azure label.
    expect(look(working).color, "Working reads apart from Waiting").not.toBe(look(waiting).color);
    expect(look(working).opacity, "Working at full strength").toBe(1);
    expect(look(waiting).opacity, "Waiting stays quiet").toBeLessThan(1);
  });
});
