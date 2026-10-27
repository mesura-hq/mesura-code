import { page } from "vite-plus/test/browser";
import { flushBrowserTasks } from "./test/browserTasks";
import { act, type Screen } from "../test/render";
// Composer undo across normal-mode sessions (modal keys phase 6) through the real ChatComposer and
// its Vim adapter; `keys/composer/composerUndo.test.ts` covers the surface. Typing is not driven by
// keys: an insert session writes the draft's prompt in INSERT, as the editor's own typing does. The
// CSS highlight registry is recorded instead of painted.

import { describe, expect, it, vi } from "vite-plus/test";
import { MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

// The boundaries the fixture replaces: see `test/appRootFenceMocks.tsx`.
const fenceMocks = vi.hoisted(() => () => import("./test/appRootFenceMocks"));
vi.mock("./state/presentation", async (original) =>
  (await fenceMocks()).mockPresentation(original),
);
vi.mock("./connection/runtime", async () => (await fenceMocks()).mockConnectionRuntime());
vi.mock("./state/entities", async (original) => (await fenceMocks()).mockEntities(original));
vi.mock("./state/environments", async (original) =>
  (await fenceMocks()).mockEnvironments(original),
);
vi.mock("./state/query", async (original) => (await fenceMocks()).mockQuery(original));
vi.mock("./state/queries", async (original) => (await fenceMocks()).mockQueries(original));
vi.mock("./state/threads", async (original) => (await fenceMocks()).mockThreads(original));
vi.mock("./state/use-atom-command", async () => (await fenceMocks()).mockAtomCommand());
vi.mock("./state/use-atom-query-runner", async () => (await fenceMocks()).mockAtomQueryRunner());
vi.mock("./state/server", async (original) => (await fenceMocks()).mockServer(original));
vi.mock("./hooks/useSettings", async (original) => (await fenceMocks()).mockSettings(original));
vi.mock("./hooks/useHandleNewThread", async () => (await fenceMocks()).mockHandleNewThread());
vi.mock("./hooks/useThreadActions", async () => (await fenceMocks()).mockThreadActions());
vi.mock("./components/Sidebar", async () => (await fenceMocks()).mockSidebar());
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

vi.mock("@t3tools/client-runtime/state/session", async (original) =>
  (await fenceMocks()).mockRuntimeSession(original),
);

import { splitPromptIntoComposerSegments } from "./composer-editor-mentions";
import { useComposerDraftStore } from "./composerDraftStore";
import { composerEditorElement } from "./keys/focusScope";
import { installKeyEngine } from "./keys/keyEngine";
import { readKeyEngineSnapshot } from "./keys/keyEngineStore";

import {
  addFenceThread,
  fenceEnvironmentId as environmentId,
  makeMessage,
  renderFenceApp,
  type FenceRouter,
} from "./test/appRootFenceApp";
import { appRootFence as fixture } from "./test/appRootFenceMocks";

let root: Screen | undefined;
let router: FenceRouter | undefined;
let container: HTMLDivElement;
let threadSequence = 0;

async function setupBrowserFixture0() {
  const previousViewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1440, 900);
  installKeyEngine();

  fixture.vimMode = false;
  fixture.highlights.clear();
  container = document.createElement("div");
  document.body.append(container);

  return {
    async [Symbol.asyncDispose]() {
      await act(async () => root?.[Symbol.asyncDispose]());
      root = undefined;
      router = undefined;
      container.remove();
      fixture.threads.clear();
      fixture.threadStates.clear();
      fixture.environments[0]!.connection.phase = "connected";
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      await page.viewport(previousViewport.width, previousViewport.height);
    },
  };
}

/** Registers a thread with an id no other test uses, and returns that id. */
function addThread(label: string, assistantText: string): ThreadId {
  threadSequence += 1;
  const id = `composer-undo-${label}-${threadSequence}`;
  return addFenceThread(id, `composer-undo ${label}`, [
    makeMessage(`${id}-user`, "user", `Question for ${label}`),
    makeMessage(`${id}-assistant`, "assistant", assistantText),
  ]);
}

/**
 * A thread whose assistant reply has four one-line paragraphs, so a cursor
 * moved up from the last line is told apart from a fresh one.
 */

async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await flushBrowserTasks();
    });
  }
}

/** Mounts the real app on a v2 thread with the chat holding the keyboard. */
async function mountApp(threadId: ThreadId) {
  ({ root, router } = await renderFenceApp(container, threadId, { vimMode: true }));
  await settle();
  // Observe ChatView's initial focus before blurring, so it cannot arrive during an edit.
  await vi.waitFor(() => expect(composer().contains(document.activeElement)).toBe(true));
  await act(async () => (document.activeElement as HTMLElement | null)?.blur?.());
}

/** Opens another thread the way the sidebar does: a navigation to its route. */
async function openThread(threadId: ThreadId) {
  fixture.openThreadId = threadId;
  await act(async () => {
    await router!.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
    } as never);
  });
  await settle();
  (document.activeElement as HTMLElement | null)?.blur?.();
  expect(
    document.querySelector(`[data-timeline-row-id*="${threadId}"]`),
    `thread ${threadId} is on screen`,
  ).not.toBeNull();
}

interface Chord {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey?: boolean;
}

/** Dispatches one keydown from the focused element, as the browser does. */
async function press(chord: Chord) {
  const event = new KeyboardEvent("keydown", { ...chord, bubbles: true, cancelable: true });
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
  await settle();
  return event;
}

const key = (letter: string): Chord => ({
  key: letter,
  code: /^\d$/.test(letter) ? `Digit${letter}` : `Key${letter.toUpperCase()}`,
});

const ESCAPE: Chord = { key: "Escape", code: "Escape" };
const REDO: Chord = { key: "r", code: "KeyR", ctrlKey: true };
// Mod is Control in the Linux Chromium fixture.
const PALETTE_CHORD: Chord = { key: "o", code: "KeyO", ctrlKey: true };

const citationSource = serializeAssistantCitation({
  version: 1,
  environmentId,
  threadId: ThreadId.make("composer-undo-cited-thread"),
  messageId: MessageId.make("composer-undo-cited-message"),
  text: "Run the migration first",
  start: 0,
  end: 23,
  prefix: "",
  suffix: "",
});

function draftOf(threadId: ThreadId) {
  return scopeThreadRef(environmentId, threadId);
}

/** The prompt the draft store holds for a thread: what the composer shows and sends. */
function promptOf(threadId: ThreadId): string {
  return useComposerDraftStore.getState().getComposerDraft(draftOf(threadId))?.prompt ?? "";
}

function composer(): HTMLElement {
  const editor = composerEditorElement();
  expect(editor, "the composer editor is mounted").not.toBeNull();
  return editor!;
}

async function focusComposer() {
  await act(async () => composer().focus());
  await vi.waitFor(() => expect(composer().contains(document.activeElement)).toBe(true));
  await settle();
  expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "INSERT" });
}

/** Sets a thread's draft before the composer is focused: text already in it. */
async function seedDraft(threadId: ThreadId, prompt: string) {
  await act(async () => useComposerDraftStore.getState().setPrompt(draftOf(threadId), prompt));
  await settle();
}

/**
 * An insert session's typing: the draft changes while the composer is in INSERT.
 * The editor's caret does not follow a draft written this way, so a spec moves
 * the normal-mode cursor with a motion before it edits.
 */
async function typeInComposer(threadId: ThreadId, prompt: string) {
  expect(readKeyEngineSnapshot(), "typing happens in insert mode").toMatchObject({
    scope: "composer",
    mode: "INSERT",
  });
  await seedDraft(threadId, prompt);
}

async function pressKeys(...letters: string[]) {
  for (const letter of letters) await press(key(letter));
}

/** Ends a normal-mode session and starts an empty insert session: `i` then Escape. */
async function emptyInsertSession() {
  await press(key("i"));
  expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "INSERT" });
  await press(ESCAPE);
  expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "NORMAL" });
}

/** Sends the draft the way the send button does: a submit of the composer's form. */
async function sendPrompt() {
  const form = composer().closest("form");
  expect(form, "the composer is inside its form").not.toBeNull();
  await act(async () => form!.requestSubmit());
  await settle();
}

function palette(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="command-palette"]');
}

/** The non-editable elements the editor draws for inline tokens' chips. */
function composerChipCount(): number {
  return composer().querySelectorAll('[contenteditable="false"]').length;
}

describe("composer undo app fence: one history per draft", () => {
  it("composer undo app fence spec: an insert session in the real composer is one undo step, and Ctrl+R redoes it", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const thread = addThread("insert", "An answer.");
    await mountApp(thread);
    await seedDraft(thread, "Fix the");
    await focusComposer();
    await typeInComposer(thread, "Fix the build please");
    await press(ESCAPE);
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "NORMAL" });

    await press(key("u"));
    expect(promptOf(thread)).toBe("Fix the");
    await press(REDO);
    expect(promptOf(thread)).toBe("Fix the build please");
  });

  it("composer undo app fence spec: sending the prompt starts a fresh history for the next draft", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const thread = addThread("send", "An answer.");
    await mountApp(thread);
    await focusComposer();
    await typeInComposer(thread, "first message");
    await press(ESCAPE);
    await pressKeys("$", "x");
    expect(promptOf(thread)).toBe("first messag");
    await press(key("a"));
    await sendPrompt();
    expect(promptOf(thread), "the send cleared the draft").toBe("");

    await focusComposer();
    await typeInComposer(thread, "second");
    await press(ESCAPE);
    await press(key("u"));
    expect(promptOf(thread)).toBe("");
    await press(key("u"));
    expect(promptOf(thread), "the sent text never comes back").toBe("");
  });

  it("composer undo app fence spec: switching thread starts a fresh history for the other thread's draft", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const threadA = addThread("switch-a", "Answer A.");
    const threadB = addThread("switch-b", "Answer B.");
    await mountApp(threadA);
    await focusComposer();
    await typeInComposer(threadA, "alpha");
    await press(ESCAPE);
    await pressKeys("$", "x");
    expect(promptOf(threadA)).toBe("alph");

    await openThread(threadB);
    await focusComposer();
    await typeInComposer(threadB, "beta");
    await press(ESCAPE);
    await press(key("u"));
    expect(promptOf(threadB)).toBe("");
    await press(key("u"));
    expect(promptOf(threadB), "thread A's history never reaches thread B's draft").toBe("");
    expect(promptOf(threadA)).toBe("alph");
  });

  it("composer undo app fence spec: returning to a thread walks back that thread's own history", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const threadA = addThread("return-a", "Answer A.");
    const threadB = addThread("return-b", "Answer B.");
    await mountApp(threadA);
    await focusComposer();
    await typeInComposer(threadA, "alpha");
    await press(ESCAPE);
    await pressKeys("$", "x");
    expect(promptOf(threadA)).toBe("alph");

    await openThread(threadB);
    await focusComposer();
    await typeInComposer(threadB, "beta");
    await press(ESCAPE);

    await openThread(threadA);
    await focusComposer();
    await press(ESCAPE);
    await press(key("u"));
    expect(promptOf(threadA)).toBe("alpha");
    await press(key("u"));
    expect(promptOf(threadA)).toBe("");
    expect(promptOf(threadB)).toBe("beta");
  });

  it("composer undo app fence spec: a palette round trip pushes no undo step and keeps the history", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const thread = addThread("palette", "An answer.");
    await mountApp(thread);
    await focusComposer();
    await typeInComposer(thread, "alpha");
    await press(ESCAPE);
    await pressKeys("$", "x");
    expect(promptOf(thread)).toBe("alph");

    await press(PALETTE_CHORD);
    await expect.element(page.getByTestId("command-palette")).toBeVisible();
    expect(palette(), "the palette chord opened the palette").not.toBeNull();
    await press(ESCAPE);
    // Base UI removes the closed popup after its CSS exit transition.
    await expect.element(page.getByTestId("command-palette")).not.toBeInTheDocument();
    await settle();
    expect(palette(), "Escape closed the palette").toBeNull();
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "NORMAL" });

    await press(key("u"));
    expect(promptOf(thread)).toBe("alpha");
    await press(key("u"));
    expect(promptOf(thread)).toBe("");
  });
});

describe("composer undo app fence: inline tokens", () => {
  it("composer undo app fence spec: a mention and a citation come back as the same tokens and chips after undo and redo", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const thread = addThread("tokens", "An answer.");
    const prompt = `@AGENTS.md ${citationSource} tail`;
    await mountApp(thread);
    await seedDraft(thread, prompt);
    await focusComposer();
    const chips = composerChipCount();
    expect(chips, "the editor draws the mention and the citation as chips").toBeGreaterThan(0);
    await press(ESCAPE);
    await pressKeys("0", "x");
    expect(promptOf(thread)).toBe(` ${citationSource} tail`);
    await emptyInsertSession();

    await press(key("u"));
    expect(promptOf(thread)).toBe(prompt);
    expect(composerChipCount()).toBe(chips);
    await press(REDO);
    expect(promptOf(thread)).toBe(` ${citationSource} tail`);
    await press(key("u"));
    expect(promptOf(thread)).toBe(prompt);
    expect(splitPromptIntoComposerSegments(promptOf(thread))).toEqual(
      splitPromptIntoComposerSegments(prompt),
    );
    expect(composerChipCount()).toBe(chips);
  });
});

describe("composer undo app fence: guards", () => {
  it("composer undo app fence guard: u inside one normal-mode session undoes the last change in the real composer", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const thread = addThread("guard", "An answer.");
    await mountApp(thread);
    await seedDraft(thread, "hello world");
    await focusComposer();
    await press(ESCAPE);
    await pressKeys("0", "d", "w");
    expect(promptOf(thread)).toBe("world");

    await press(key("u"));
    expect(promptOf(thread)).toBe("hello world");
    await press(REDO);
    expect(promptOf(thread)).toBe("world");
  });
});

// Review finding P1-1 on the first implementation: the history was cleared as
// soon as the send was dispatched, even when the send kept the draft.
describe("composer undo app fence: review regressions", () => {
  it("composer undo app fence regression: a send refused while the environment reconnects keeps the draft's history", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    fixture.environments[0]!.connection.phase = "reconnecting";
    const thread = addThread("refused", "An answer.");
    await mountApp(thread);
    await focusComposer();
    await typeInComposer(thread, "alpha");
    await press(ESCAPE);
    await pressKeys("$", "x");
    expect(promptOf(thread)).toBe("alph");
    await press(key("a"));
    await sendPrompt();
    expect(promptOf(thread), "the refused send kept the draft").toBe("alph");

    await press(ESCAPE);
    await press(key("u"));
    expect(promptOf(thread)).toBe("alpha");
    await press(key("u"));
    expect(promptOf(thread)).toBe("");
  });
});
