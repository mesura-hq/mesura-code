// @vitest-environment happy-dom
/**
 * Entry point: AppRoot, with a memory router whose root renders the real
 * CommandPalette around the real AppSidebarLayout, as `routes/__root.tsx`
 * does, and whose chat layout is the real `_chat.tsx` route component (the
 * real KeyEngineHost around the real ChatView). The timeline mounts the real
 * AssistantSelectionToolbar, as `MessagesTimeline.tsx` does. The key engine
 * is installed on `window` before React renders, as `main.tsx` does.
 *
 * A mouse cite is a native selection over a timeline row's text, a primary
 * press in the timeline and a release, as the browser reports a drag, then a
 * click on the toolbar's *Cite selection in composer* button. A keyboard cite
 * is real `keydown` events from the focused element. A flash is observed as
 * `[data-mesura-cite-flash]` boxes in the DOM, and counted with a
 * MutationObserver, so a second flash of the same cite is seen even after the
 * first is removed.
 *
 * Phase 3 of the Vim keys round 2 cycle (flash the cited text for every cite,
 * the mouse included):
 * - Criterion 1: the mouse Cite button flashes the cited text.
 * - Criterion 2: a visual-mode cite and a flash cite each flash once.
 * - Criterion 3, guard: a refused cite (text too long) flashes nothing.
 * - Criterion 4, guard: in `citeFlash.test.ts`, which reads `mesura.css`.
 * - Criterion 5, guard: the boxes go on `animationend`, or after 1100 ms.
 * - Criterion 6, guard: with Vim mode on, the mouse cite lands the composer
 *   in insert mode after the chip.
 *
 * happy-dom has no layout. The boxes the cite path measures are stubbed: the
 * reading area (the timeline's scroller and the citation viewport), the
 * composer below it, and every text range as one line inside it, with nothing
 * over it. Everything else the fixture replaces is shared with the other
 * fences in `test/appRootFenceMocks.tsx`.
 *
 * Every timer and animation frame runs on Vitest's fake clock from setup on.
 * `settle` runs what is due without moving the clock, and only the tests
 * that remove a flash by time move it as far as 1100 ms.
 */
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ASSISTANT_CITATION_MAX_TEXT_LENGTH, type ThreadId } from "@t3tools/contracts";
import { collectAssistantCitations } from "@t3tools/shared/assistantCitations";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

// The boundaries the fixture replaces: see `test/appRootFenceMocks.tsx`.
const fenceMocks = vi.hoisted(() => () => import("./test/appRootFenceMocks"));
vi.mock("./state/entities", async (original) => (await fenceMocks()).mockEntities(original));
vi.mock("./state/environments", async (original) =>
  (await fenceMocks()).mockEnvironments(original),
);
vi.mock("./state/query", async () => (await fenceMocks()).mockQuery());
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
import { stopFlash } from "./keys/flashSession";
import { useFlashSnapshot, type FlashSnapshot } from "./keys/flashStore";
import { installKeyEngine } from "./keys/keyEngine";
import { readKeyEngineSnapshot } from "./keys/keyEngineStore";
import {
  addFenceThread,
  fenceEnvironmentId as environmentId,
  makeMessage,
  renderFenceApp,
} from "./test/appRootFenceApp";
import { appRootFence as fixture, FENCE_SCROLLER_TESTID } from "./test/appRootFenceMocks";

const FLASH_SELECTOR = "[data-mesura-cite-flash]";
const CITE_BUTTON_SELECTOR = 'button[aria-label="Cite selection in composer"]';
const TOO_LONG_BUTTON_SELECTOR = 'button[aria-label="Selection is too long to cite"]';
let root: Root | undefined;
let probeRoot: Root | undefined;
let container: HTMLDivElement;
let threadSequence = 0;
let flash: FlashSnapshot;
let flashObserver: MutationObserver;
/** Every flash anchor added to the document since the test began. */
let flashesAdded = 0;

beforeAll(() => {
  installKeyEngine();
});

/**
 * Registers a thread whose only message is one assistant reply, so the chat
 * buffer is that reply's lines and nothing else; returns its id.
 */
function addReplyThread(label: string, assistantText: string): ThreadId {
  threadSequence += 1;
  const id = `cite-flash-${label}-${threadSequence}`;
  return addFenceThread(id, `Cite flash ${label}`, [
    makeMessage(`${id}-assistant`, "assistant", assistantText),
  ]);
}

/** One sentence, so a flash cite has one start label and one end label. */
const CITED_SENTENCE = "The build failed on a missing type.";
/** One paragraph longer than `ASSISTANT_CITATION_MAX_TEXT_LENGTH`. */
const TOO_LONG_PARAGRAPH = "This reply is far too long to cite whole. ".repeat(
  Math.ceil((ASSISTANT_CITATION_MAX_TEXT_LENGTH + 1) / 42),
);

function rect(top: number, height: number, left = 10, width = 200): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left,
    right: left + width,
    width,
    x: left,
    y: top,
  } as DOMRect;
}

function FlashProbe() {
  const snapshot = useFlashSnapshot();
  useLayoutEffect(() => {
    flash = snapshot;
  });
  return null;
}

beforeEach(() => {
  // Every timer and frame runs on test time, so a flash's 1100 ms removal
  // fires only when a test advances the clock that far.
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.vimMode = false;
  fixture.highlights.clear();
  container = document.createElement("div");
  document.body.append(container);
  flashesAdded = 0;
  flashObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element && node.matches(FLASH_SELECTOR)) flashesAdded += 1;
      }
    }
  });
  flashObserver.observe(document.body, { childList: true, subtree: true });
  // Every text range draws as one line inside the reading area.
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(() => rect(100, 16));
  vi.spyOn(Range.prototype, "getClientRects").mockImplementation(() => {
    const rects = [rect(100, 16)];
    return Object.assign(rects, {
      item: (index: number) => rects[index] ?? null,
    }) as unknown as DOMRectList;
  });
  // Nothing covers the text: the point under it is in the scroller.
  vi.spyOn(document, "elementFromPoint").mockImplementation(() =>
    document.querySelector(`[data-testid="${FENCE_SCROLLER_TESTID}"]`),
  );
});

afterEach(async () => {
  vi.useRealTimers();
  flashObserver.disconnect();
  act(() => stopFlash());
  await act(async () => {
    probeRoot?.unmount();
    root?.unmount();
  });
  probeRoot = undefined;
  root = undefined;
  container.remove();
  document.querySelectorAll(FLASH_SELECTOR).forEach((anchor) => anchor.remove());
  window.getSelection()?.removeAllRanges();
  fixture.threads.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Longer than any startup timer the app sets on mount. */
const APP_STARTUP_MS = 5_000;

/** Runs the React work, timers and frames due now, without moving the clock. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

/** Moves the clock one frame and settles: for work the app runs in a frame. */
async function nextFrame(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(16);
  });
  await settle();
}

/** Gives the reading area, the citation viewport and the composer their boxes. */
function stubLayout(): void {
  const scroller = document.querySelector<HTMLElement>(`[data-testid="${FENCE_SCROLLER_TESTID}"]`);
  expect(scroller, "the timeline's scroller is mounted").not.toBeNull();
  Object.defineProperty(scroller!, "scrollHeight", { configurable: true, value: 2000 });
  Object.defineProperty(scroller!, "clientHeight", { configurable: true, value: 600 });
  scroller!.getBoundingClientRect = () => rect(0, 600, 0, 800);
  const viewport = document.querySelector<HTMLElement>("[data-assistant-citation-viewport]");
  expect(viewport, "the citation viewport is mounted").not.toBeNull();
  viewport!.getBoundingClientRect = () => rect(0, 600, 0, 800);
  const composer = document.querySelector<HTMLElement>('[data-slot="composer-shell"]');
  if (composer) composer.getBoundingClientRect = () => rect(620, 120, 0, 800);
}

/** Mounts the app on `threadId`, the chat holding the keyboard. */
async function mountApp(threadId: ThreadId, { vimMode }: { vimMode: boolean }) {
  ({ root } = await renderFenceApp(container, threadId, { vimMode }));
  // The app's own startup timers (focus moves among them) run out before
  // any test step, as they would on a real clock long before a click.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(APP_STARTUP_MS);
  });
  await settle();
  stubLayout();
  const probe = document.createElement("div");
  document.body.append(probe);
  probeRoot = createRoot(probe);
  act(() => probeRoot!.render(<FlashProbe />));
  (document.activeElement as HTMLElement | null)?.blur?.();
}

interface Chord {
  readonly key: string;
  readonly code: string;
}

function keydown(chord: Chord): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { ...chord, bubbles: true, cancelable: true });
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
  return event;
}

/** Dispatches one keydown from the focused element, as the browser does. */
async function press(chord: Chord) {
  const event = keydown(chord);
  await settle();
  return event;
}

const key = (letter: string): Chord => ({ key: letter, code: `Key${letter.toUpperCase()}` });
const SHIFT_V: Chord = { key: "V", code: "KeyV" };
const SPACE: Chord = { key: " ", code: "Space" };

/** The text node of the reply that holds `text`, and the timeline row it is in. */
function replyText(text: string): { node: Text; row: HTMLElement } {
  const source = document.querySelector<HTMLElement>("[data-assistant-citation-source]");
  expect(source, "the assistant reply is on screen").not.toBeNull();
  const walker = document.createTreeWalker(source!, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.includes(text)) {
      const row = node.parentElement!.closest<HTMLElement>("[data-timeline-row-kind]");
      expect(row, "the reply's text is inside a timeline row").not.toBeNull();
      return { node: node as Text, row: row! };
    }
  }
  throw new Error(`no reply text holds: ${text}`);
}

/**
 * Selects `text` in the reply with the mouse: a primary press in the
 * timeline, the native selection the drag makes, and the release; then
 * returns the selection toolbar's `buttonSelector` button.
 */
async function selectWithMouse(text: string, buttonSelector: string): Promise<HTMLButtonElement> {
  const { node } = replyText(text);
  const start = node.textContent!.indexOf(text);
  const target = node.parentElement!;
  act(() => {
    target.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true }),
    );
  });
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + text.length);
  act(() => {
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  act(() => {
    target.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, button: 0, isPrimary: true }),
    );
    target.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        button: 0,
        detail: 1,
        clientX: 200,
        clientY: 116,
      }),
    );
  });
  // The toolbar opens a frame after the release.
  await nextFrame();
  const button = document.querySelector<HTMLButtonElement>(buttonSelector);
  expect(button, `the selection toolbar shows ${buttonSelector}`).not.toBeNull();
  return button!;
}

/** The cited prompt of `threadId`'s composer draft. */
function promptOf(threadId: ThreadId): string {
  return (
    useComposerDraftStore.getState().getComposerDraft(scopeThreadRef(environmentId, threadId))
      ?.prompt ?? ""
  );
}

/** Cites the whole reply line in visual-line mode: `V`, then `<Space>c`. */
async function citeLineByKeys(): Promise<void> {
  await press(SHIFT_V);
  expect(readKeyEngineSnapshot()).toMatchObject({ scope: "chat", mode: "V-LINE" });
  await press(SPACE);
  await press(key("c"));
}

describe("cite flash fence: the mouse Cite button", () => {
  it("cite flash fence spec: clicking Cite selection in composer flashes the cited text in its timeline row", async () => {
    const thread = addReplyThread("mouse", CITED_SENTENCE);
    await mountApp(thread, { vimMode: false });
    const button = await selectWithMouse(CITED_SENTENCE, CITE_BUTTON_SELECTOR);

    act(() => button.click());

    expect(collectAssistantCitations(promptOf(thread)), "the composer took the cite").toHaveLength(
      1,
    );
    // Drawn by the click itself, before any frame: within 200 ms of it.
    const anchor = document.querySelector<HTMLElement>(FLASH_SELECTOR);
    expect(anchor, "a flash is drawn when the Cite button is clicked").not.toBeNull();
    expect(anchor!.closest("[data-timeline-row-kind]")).toBe(replyText(CITED_SENTENCE).row);
    expect(anchor!.getAttribute("aria-hidden")).toBe("true");
    // One box per line of the cited text, placed where the text draws.
    expect(anchor!.children).toHaveLength(1);
    const box = anchor!.children[0] as HTMLElement;
    expect([box.style.top, box.style.width, box.style.height]).toEqual(["100px", "200px", "16px"]);
    await settle();
    expect(flashesAdded, "the mouse cite flashes exactly once").toBe(1);
  });
});

describe("cite flash fence: each keyboard cite flashes once", () => {
  it("cite flash fence spec: a visual-mode cite flashes the cited text exactly once", async () => {
    const thread = addReplyThread("visual", CITED_SENTENCE);
    await mountApp(thread, { vimMode: true });
    await citeLineByKeys();

    expect(readKeyEngineSnapshot()).toMatchObject({ notice: "cited into the composer" });
    expect(collectAssistantCitations(promptOf(thread))).toHaveLength(1);
    expect(flashesAdded, "the visual-mode cite flashes exactly once").toBe(1);
    expect(document.querySelectorAll(FLASH_SELECTOR)).toHaveLength(1);
  });

  it("cite flash fence spec: a flash cite through its two picks flashes the cited text exactly once", async () => {
    const thread = addReplyThread("pick", CITED_SENTENCE);
    await mountApp(thread, { vimMode: true });
    await press(SPACE);
    await press(key("c"));
    expect(flash.hint).toBe("cite: where it starts");
    await press(key(flash.labels[0]!.label));
    expect(flash.hint).toBe("cite: where it ends");
    await press(key(flash.labels[0]!.label));

    expect(readKeyEngineSnapshot()).toMatchObject({ notice: "cited into the composer" });
    const citations = collectAssistantCitations(promptOf(thread));
    expect(citations.map(({ citation }) => citation.text)).toEqual([CITED_SENTENCE]);
    expect(flashesAdded, "the flash cite flashes exactly once").toBe(1);
    expect(document.querySelectorAll(FLASH_SELECTOR)).toHaveLength(1);
  });
});

// Already true at the base, and must stay so: guards.
describe("cite flash fence: a refused cite flashes nothing", () => {
  it("cite flash fence guard: the too-long mouse selection's disabled button cites and flashes nothing", async () => {
    const thread = addReplyThread("long-mouse", TOO_LONG_PARAGRAPH);
    await mountApp(thread, { vimMode: false });
    const button = await selectWithMouse(TOO_LONG_PARAGRAPH.trim(), TOO_LONG_BUTTON_SELECTOR);
    expect(button.disabled).toBe(true);

    act(() => button.click());
    await settle();

    expect(promptOf(thread)).toBe("");
    expect(flashesAdded).toBe(0);
  });

  it("cite flash fence guard: a too-long visual-mode cite is refused and flashes nothing", async () => {
    const thread = addReplyThread("long-keys", TOO_LONG_PARAGRAPH);
    await mountApp(thread, { vimMode: true });
    await citeLineByKeys();

    expect(readKeyEngineSnapshot()).toMatchObject({ notice: "only assistant text can be cited" });
    expect(promptOf(thread)).toBe("");
    expect(flashesAdded).toBe(0);
  });
});

// Already true at the base for the keyboard cites, and must stay so: guards.
describe("cite flash fence: the flash boxes go away", () => {
  it("cite flash fence guard: a cite's flash boxes are removed when their animation ends", async () => {
    const thread = addReplyThread("animationend", CITED_SENTENCE);
    await mountApp(thread, { vimMode: true });
    await citeLineByKeys();
    const anchor = document.querySelector(FLASH_SELECTOR);
    expect(anchor, "the cite drew a flash").not.toBeNull();

    act(() => {
      anchor!.dispatchEvent(new Event("animationend"));
    });

    expect(document.querySelector(FLASH_SELECTOR)).toBeNull();
  });

  it("cite flash fence guard: a cite's flash boxes are removed after 1100 ms when no animation runs", async () => {
    const thread = addReplyThread("fallback", CITED_SENTENCE);
    await mountApp(thread, { vimMode: true });
    await press(SHIFT_V);
    await press(SPACE);
    await press(key("c"));
    expect(document.querySelector(FLASH_SELECTOR), "the cite drew a flash").not.toBeNull();

    act(() => vi.advanceTimersByTime(1099));
    expect(document.querySelector(FLASH_SELECTOR)).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(document.querySelector(FLASH_SELECTOR)).toBeNull();
  });
});

// Already true at the base, and must stay so: a guard.
describe("cite flash fence: the mouse cite in Vim mode", () => {
  it("cite flash fence guard: with Vim mode on the mouse cite lands the composer in insert mode after the chip", async () => {
    const thread = addReplyThread("vim-mouse", CITED_SENTENCE);
    await mountApp(thread, { vimMode: true });
    const button = await selectWithMouse(CITED_SENTENCE, CITE_BUTTON_SELECTOR);

    act(() => button.click());

    // The composer takes focus a frame after the cite.
    await nextFrame();
    expect(readKeyEngineSnapshot()).toMatchObject({ scope: "composer", mode: "INSERT" });
    // The chip at the prompt's end, on its own line, then `: ` for the comment.
    const prompt = promptOf(thread);
    expect(prompt.endsWith(": "), `prompt: ${JSON.stringify(prompt)}`).toBe(true);
    const citations = collectAssistantCitations(prompt);
    expect(citations.map(({ citation }) => citation.text)).toEqual([CITED_SENTENCE]);
    // The caret is in the composer's editor, after everything in it.
    const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
    expect(editor?.contains(document.activeElement)).toBe(true);
    const caret = window.getSelection()!;
    expect(caret.isCollapsed).toBe(true);
    const afterCaret = document.createRange();
    afterCaret.setStart(caret.focusNode!, caret.focusOffset);
    afterCaret.setEnd(editor!, editor!.childNodes.length);
    expect(afterCaret.toString()).toBe("");
  });
});
