import { page } from "vite-plus/test/browser";
import { flushBrowserTasks } from "./test/browserTasks";
import { act, type Screen } from "../test/render";
// Chat cursor memory per thread (modal keys phase 5) through AppRoot, `_chat.tsx` and ChatView. The
// thread route reads its ids from params, so opening a thread re-renders the same ChatView. Each
// test uses thread ids no other test uses: the chat surface's state is module-level and lives for
// the file. Boundaries are shared in `test/appRootFenceMocks.tsx`.

import { describe, expect, it, vi } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import { collectAssistantCitations } from "@t3tools/shared/assistantCitations";
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

import { useComposerDraftStore } from "./composerDraftStore";
import { installKeyEngine } from "./keys/keyEngine";
import { readKeyEngineSnapshot } from "./keys/keyEngineStore";
import { readAssistantText } from "./lib/assistantTextSelection";
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
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      await page.viewport(previousViewport.width, previousViewport.height);
    },
  };
}

/** Registers a thread with an id no other test uses, and returns that id. */
function addThread(label: string, assistantText: string): ThreadId {
  threadSequence += 1;
  const id = `thread-recall-${label}-${threadSequence}`;
  return addFenceThread(id, `Cursor memory ${label}`, [
    makeMessage(`${id}-user`, "user", `Question for ${label}`),
    makeMessage(`${id}-assistant`, "assistant", assistantText),
  ]);
}

/**
 * A thread whose assistant reply has four one-line paragraphs, so a cursor
 * moved up from the last line is told apart from a fresh one.
 */
function addParagraphThread(label: string): ThreadId {
  return addThread(
    label,
    [
      `${label} first paragraph.`,
      `${label} second paragraph.`,
      `${label} third paragraph.`,
      `${label} last paragraph.`,
    ].join("\n\n"),
  );
}

const SOFT_PARAGRAPH = "Cite the first half\nand the second half.";
const SOFT_PARAGRAPH_RENDERED = "Cite the first half and the second half.";

/** A thread whose reply opens with a paragraph that has one soft break. */
function addSoftBreakThread(): ThreadId {
  return addThread("soft", [SOFT_PARAGRAPH, "The next block.", "The closing block."].join("\n\n"));
}

async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await flushBrowserTasks();
    });
  }
}

/** Mounts the app on `threadId` with Vim mode on, the chat holding the keyboard. */
async function mountApp(threadId: ThreadId) {
  ({ root, router } = await renderFenceApp(container, threadId, { vimMode: true }));
  await settle();
  (document.activeElement as HTMLElement | null)?.blur?.();
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

const key = (letter: string): Chord => ({ key: letter, code: `Key${letter.toUpperCase()}` });
const DOLLAR: Chord = { key: "$", code: "Digit4" };
const SPACE: Chord = { key: " ", code: "Space" };

/** Reaches the last reply line through Vim motion, independent of the first visible line. */
async function moveToLastLine() {
  await press({ key: "9", code: "Digit9" });
  await press({ key: "9", code: "Digit9" });
  await press(key("j"));
  expect(readKeyEngineSnapshot()).toMatchObject({ scope: "chat", mode: "NORMAL" });
}

interface PaintedCursor {
  /** The timeline row the cursor is in. */
  readonly rowId: string;
  /** The cursor's offset in that row's projected text. */
  readonly offset: number;
  /** The text node the cursor is painted in, for a readable failure. */
  readonly text: string;
}

/** Where the chat cursor was last painted, as a row and an offset into its text. */
function paintedCursor(): PaintedCursor | null {
  const range = fixture.highlights.get("mesura-chat-cursor")?.[0];
  if (!range) return null;
  const node = range.startContainer;
  const row = node.parentElement?.closest<HTMLElement>("[data-timeline-row-id]");
  expect(row, "the cursor is painted inside a timeline row").toBeTruthy();
  const source = row!.querySelector<HTMLElement>("[data-assistant-citation-source]") ?? row!;
  const chunk = readAssistantText(source).chunks.find((candidate) => candidate.node === node);
  expect(chunk, "the cursor's text node is part of the row's projected text").toBeDefined();
  return {
    rowId: row!.dataset.timelineRowId ?? "",
    offset: chunk!.start + range.startOffset,
    text: node.textContent ?? "",
  };
}

/** The row ids of every timeline row on screen. */
function timelineRowIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[data-timeline-row-id]")].map(
    (row) => row.dataset.timelineRowId ?? "",
  );
}

describe("cursor memory fence: the chat cursor per thread", () => {
  it("cursor memory fence spec: returning to thread A puts the cursor on the row and offset it had", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const threadA = addParagraphThread("A");
    const threadB = addParagraphThread("B");
    await mountApp(threadA);
    await moveToLastLine();
    expect(paintedCursor()?.text).toBe("A last paragraph.");
    // Two lines up from the reply's last paragraph.
    await press(key("k"));
    await press(key("k"));
    const before = paintedCursor();
    expect(before?.text).toBe("A second paragraph.");

    await openThread(threadB);
    await moveToLastLine();
    expect(paintedCursor()?.text).toBe("B last paragraph.");
    await press(key("k"));
    expect(paintedCursor()?.text, "the cursor moved in thread B").toBe("B third paragraph.");

    await openThread(threadA);
    // `h` at the start of a line does not move: it paints where the cursor is.
    await press(key("h"));
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "chat", mode: "NORMAL" });
    expect(paintedCursor()).toEqual(before);
  });

  it("cursor memory fence spec: returning to thread B after thread A puts B's cursor back too", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const threadA = addParagraphThread("A");
    const threadB = addParagraphThread("B");
    await mountApp(threadA);
    await moveToLastLine();
    await press(key("k"));

    await openThread(threadB);
    await moveToLastLine();
    await press(key("k"));
    await press(key("k"));
    const inB = paintedCursor();
    expect(inB?.text).toBe("B second paragraph.");

    await openThread(threadA);
    await press(key("h"));
    await openThread(threadB);
    await press(key("h"));
    expect(paintedCursor()).toEqual(inB);
  });

  // Review P1-1: a key that leaves the fallback cursor where it is must not
  // replace the remembered position of a row that is not mounted.
  it("cursor memory fence regression: a remembered row that unmounts and mounts again gets its cursor back", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const threadA = addParagraphThread("A");
    const threadB = addParagraphThread("B");
    await mountApp(threadA);
    await moveToLastLine();
    await press(key("k"));
    await press(key("k"));
    const before = paintedCursor();
    expect(before?.text).toBe("A second paragraph.");
    await openThread(threadB);
    await moveToLastLine();
    await press(key("k"));

    // Thread A comes back without the remembered row: the cursor falls back
    // to the first visible line, and `h` there moves nothing.
    const originalShell = fixture.threads.get(threadA)!;
    const originalState = fixture.threadStates.get(threadA)!;
    addFenceThread(threadA, originalShell.title, [
      makeMessage(`${threadA}-user`, "user", "Question for A"),
      makeMessage(`${threadA}-replacement`, "assistant", "A replacement reply."),
    ]);
    await openThread(threadA);
    expect(document.querySelector(`[data-timeline-row-id="${before!.rowId}"]`)).toBeNull();
    await press(key("h"));
    expect(paintedCursor()).toMatchObject({
      rowId: expect.stringContaining(`${threadA}-user`),
      text: "Question for A",
    });
    const fallback = paintedCursor()!;
    expect(fallback.offset).toBe(readAssistantRowText(fallback.rowId).indexOf("Question for A"));
    expect(document.querySelector("[data-assistant-citation-source]")?.textContent).toBe(
      "A replacement reply.",
    );

    // The remembered row mounts again.
    fixture.threads.set(threadA, originalShell);
    fixture.threadStates.set(threadA, originalState);
    await act(async () => {
      for (const listener of fixture.threadListeners) listener();
    });
    await settle();
    await press(key("h"));
    expect(paintedCursor()).toEqual(before);
  });

  // Already true at the base, and must stay so: a guard.
  it("cursor memory fence guard: a thread opened for the first time starts at the first visible line", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const threadA = addParagraphThread("A");
    const threadC = addParagraphThread("C");
    await mountApp(threadA);
    await moveToLastLine();
    await press(key("k"));
    await press(key("k"));

    await openThread(threadC);
    await press(key("h"));

    // The question is the first visible line in this native desktop viewport.
    const cursor = paintedCursor();
    expect(cursor?.rowId).toContain(`${threadC}-user`);
    expect(cursor?.text).toBe("Question for C");
    expect(cursor?.offset).toBe(readAssistantRowText(cursor!.rowId).indexOf("Question for C"));
    const range = fixture.highlights.get("mesura-chat-cursor")![0]!;
    expect(
      range.getBoundingClientRect().height,
      "the first line has native geometry",
    ).toBeGreaterThan(0);
  });

  // Already true at the base (nothing is remembered), and must stay so: a guard.
  it("cursor memory fence guard: remembering the cursor writes nothing to localStorage or sessionStorage", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    // Both browser stores record writes, so cursor persistence cannot hide
    // behind a different storage API.
    const writes: string[] = [];
    for (const name of ["localStorage", "sessionStorage"] as const) {
      const store = recordingStorage(name, writes);
      vi.stubGlobal(name, store);
      expect(window[name], `window.${name} is the recording store`).toBe(store);
    }
    window.localStorage.setItem("thread-recall-probe", "1");
    window.sessionStorage.setItem("thread-recall-probe", "1");
    expect(writes).toEqual([
      "localStorage:thread-recall-probe=1",
      "sessionStorage:thread-recall-probe=1",
    ]);
    writes.length = 0;

    const threadA = addParagraphThread("A");
    const threadB = addParagraphThread("B");
    await mountApp(threadA);
    await moveToLastLine();
    const rowIds = new Set(timelineRowIds());
    await press(key("k"));
    await press(key("k"));
    await openThread(threadB);
    await moveToLastLine();
    for (const rowId of timelineRowIds()) rowIds.add(rowId);
    await press(key("k"));
    await openThread(threadA);
    await press(key("h"));

    for (const write of writes) {
      expect(write, "a storage write names the chat cursor").not.toMatch(/cursor/i);
      for (const rowId of rowIds) {
        expect(write.includes(rowId), `a storage write holds the row id ${rowId}`).toBe(false);
      }
    }
  });
});

/** A Web Storage that records every write as `<store>:<key>=<value>`. */
function recordingStorage(name: string, writes: string[]): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (storageKey) => items.get(storageKey) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (storageKey) => {
      items.delete(storageKey);
    },
    setItem: (storageKey, value) => {
      writes.push(`${name}:${storageKey}=${value}`);
      items.set(storageKey, String(value));
    },
  };
}

/** A row's projected text, read the way the chat buffer reads it. */
function readAssistantRowText(rowId: string): string {
  const row = document.querySelector<HTMLElement>(`[data-timeline-row-id="${rowId}"]`)!;
  const source = row.querySelector<HTMLElement>("[data-assistant-citation-source]") ?? row;
  return readAssistantText(source).text;
}

// Review P1-2: a separator line mapped back to the row after it, so `k`
// from a row's first line never reached the row before.
describe("cursor memory fence: vertical motion across rows", () => {
  it("cursor memory fence regression: k from a row's first line crosses the separator into the row before, and j comes back", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const thread = addParagraphThread("R");
    await mountApp(thread);
    await moveToLastLine();
    expect(paintedCursor()?.text).toBe("R last paragraph.");
    for (let step = 0; step < 3; step += 1) await press(key("k"));
    expect(paintedCursor()?.text).toBe("R first paragraph.");

    // The separator between rows has no character, so nothing is painted.
    await press(key("k"));
    expect(paintedCursor()).toBeNull();
    await press(key("k"));
    // The user row's last line: the time it was sent.
    expect(paintedCursor()?.rowId).toContain("-user");
    await press(key("k"));
    const question = paintedCursor();
    expect(question?.text).toBe("Question for R");
    // The start of that line, after the row's screen-reader author heading.
    expect(question?.offset).toBe(readAssistantRowText(question!.rowId).indexOf("Question for R"));
    await press(key("j"));
    expect(paintedCursor()?.rowId).toContain("-user");

    await press(key("j"));
    expect(paintedCursor()).toBeNull();
    await press(key("j"));
    expect(paintedCursor()?.text).toBe("R first paragraph.");
  });
});

describe("cursor memory fence: soft breaks read as spaces", () => {
  it("cursor memory fence spec: a paragraph with one soft break is one line and j from it lands on the next block", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const thread = addSoftBreakThread();
    await mountApp(thread);
    await moveToLastLine();
    expect(paintedCursor()?.text).toBe("The closing block.");
    // From the last line, two lines up is the paragraph when it is one line.
    await press(key("k"));
    expect(paintedCursor()?.text).toBe("The next block.");
    await press(key("k"));
    expect(paintedCursor()).toMatchObject({ text: SOFT_PARAGRAPH, offset: 0 });

    await press(key("j"));
    expect(paintedCursor()?.text).toBe("The next block.");
  });

  it("cursor memory fence spec: a visual selection across a soft break cites the exact rendered text", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const thread = addSoftBreakThread();
    await mountApp(thread);
    await moveToLastLine();
    expect(paintedCursor()?.text).toBe("The closing block.");
    await press(key("k"));
    await press(key("k"));
    // The whole paragraph, across its former soft break.
    await press(key("v"));
    await press(DOLLAR);
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "chat", mode: "VISUAL" });
    await press(SPACE);
    await press(key("c"));

    expect(readKeyEngineSnapshot()).toMatchObject({ notice: "cited into the composer" });
    const prompt =
      useComposerDraftStore.getState().getComposerDraft(scopeThreadRef(environmentId, thread))
        ?.prompt ?? "";
    const citations = collectAssistantCitations(prompt);
    expect(citations, `the prompt carries one citation; prompt: ${prompt}`).toHaveLength(1);
    const { citation } = citations[0]!;
    // A citation compares quotes with each whitespace run collapsed to one
    // space (`findAssistantCitationText`): that is the rendered text.
    expect(citation.text.replace(/\s+/g, " ")).toBe(SOFT_PARAGRAPH_RENDERED);
    expect([citation.start, citation.end]).toEqual([0, SOFT_PARAGRAPH_RENDERED.length]);
  });
});
