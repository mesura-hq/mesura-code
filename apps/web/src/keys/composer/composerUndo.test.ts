// @vitest-environment happy-dom
/**
 * Entry point: `composerSurface`, driven the way the key engine drives it
 * (`handleKey`, one token per key) and the composer drives it
 * (`registerComposerVimAdapter`, focus arriving in and leaving the editor).
 * The adapter is a stand-in for `ChatComposer.tsx`'s: it holds one draft's
 * prompt and collapsed cursor, and reports which draft that is.
 * `AppRoot.composerUndo.fence.test.tsx` covers the same criteria through the
 * real composer.
 *
 * Phase 6 of the modal keys production cycle (composer undo spans normal-mode
 * sessions):
 * - Criterion 1: an insert session is one undo step.
 * - Criterion 2: undo walks back across several normal-mode sessions in order.
 * - Criterion 3: `Ctrl+R` redoes what `u` undid; a new change clears redo.
 * - Criterion 4: the cursor after `u` and `Ctrl+R` is at the start of the
 *   changed text.
 * - Criterion 5: switching thread starts a fresh history for the new draft;
 *   returning to a thread walks back that draft's own history, with text
 *   changed elsewhere as its latest state.
 * - Criterion 6: mentions, citations, skills and context references survive
 *   undo and redo as the same tokens.
 * - The palette resume (`resumeComposerNormalOnFocus`) pushes no step by
 *   itself, and the history survives it.
 * - Guard: `u` inside one normal-mode session undoes the last change.
 */
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";

import { splitPromptIntoComposerSegments } from "~/composer-editor-mentions";
import { formatTerminalContextReference } from "~/lib/terminalContext";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { composerTargetKey, useComposerDraftStore } from "~/composerDraftStore";
import { consumeDirectedComposerDraft } from "~/dictation/directedComposerSubmission";
import { projectPrompt } from "./composerProjection";
import {
  composerNormalOffset,
  composerSurface,
  registerComposerVimAdapter,
  resumeComposerNormalOnFocus,
} from "./composerSurface";
import { ComposerTextBuffer, recordComposerUndoState, undoComposerChange } from "./composerUndo";

interface FakeDraft {
  /** The draft the adapter reports: the thread the composer is open on. */
  draftKey: string;
  prompt: string;
  /** The collapsed cursor: one character per inline token. */
  cursor: number;
  readonly writes: Array<{ readonly prompt: string; readonly cursor: number }>;
}

let draftSequence = 0;
let editor: HTMLElement;
let draft: FakeDraft;
let disposeAdapter: () => void = () => {};

/** A draft key no other test uses: the undo history is module state. */
function freshDraftKey(label: string): string {
  draftSequence += 1;
  return `composer-undo-${label}-${draftSequence}`;
}

/** Registers a stand-in composer on a draft holding `prompt`, caret at its end. */
function openDraft(prompt: string, label = "draft"): void {
  const cursor = projectPrompt(prompt).text.length;
  draft = { draftKey: freshDraftKey(label), prompt, cursor, writes: [] };
  const state = draft;
  const adapter = {
    draftKey: () => state.draftKey,
    read: () => ({ prompt: state.prompt, cursor: state.cursor }),
    write: (prompt: string, cursor: number) => {
      state.prompt = prompt;
      state.cursor = cursor;
      state.writes.push({ prompt, cursor });
    },
    setCursor: (cursor: number) => {
      state.cursor = cursor;
    },
  };
  disposeAdapter = registerComposerVimAdapter(adapter);
}

function focusComposer(): void {
  editor.dispatchEvent(new FocusEvent("focusin", { bubbles: true, relatedTarget: null }));
}

function blurComposer(): void {
  editor.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
}

/** Hands the surface one token as the key engine does, with its keydown event. */
function press(token: string): boolean {
  const ctrl = /^<C-(.)>$/.exec(token);
  const key = token === "<Esc>" ? "Escape" : (ctrl?.[1] ?? token);
  return composerSurface.handleKey(
    token,
    new KeyboardEvent("keydown", { key, ctrlKey: ctrl !== null }),
  );
}

function pressAll(...tokens: string[]): void {
  for (const token of tokens) press(token);
}

/**
 * Types plain text at the caret in insert mode: the engine sees each key and
 * passes it on, and the editor inserts it. Only for prompts without tokens,
 * where the collapsed cursor is a plain offset.
 */
function type(text: string): void {
  expect(composerSurface.mode(), "typing happens in insert mode").toBe("insert");
  for (const char of text) {
    expect(press(char), `insert mode passes "${char}" to the editor`).toBe(false);
    draft.prompt = draft.prompt.slice(0, draft.cursor) + char + draft.prompt.slice(draft.cursor);
    draft.cursor += 1;
  }
}

/** Ends a normal-mode session and starts an empty insert session: `i` then Escape. */
function emptyInsertSession(): void {
  press("i");
  expect(composerSurface.mode()).toBe("insert");
  press("<Esc>");
  expect(composerSurface.mode()).toBe("normal");
}

const citationSource = serializeAssistantCitation({
  version: 1,
  environmentId: EnvironmentId.make("composer-undo-environment"),
  threadId: ThreadId.make("composer-undo-thread"),
  messageId: MessageId.make("composer-undo-message"),
  text: "Run the migration first",
  start: 0,
  end: 23,
  prefix: "",
  suffix: "",
});
const terminalReference = formatTerminalContextReference({
  id: "composer-undo-ctx",
  terminalLabel: "Terminal 1",
  lineStart: 3,
  lineEnd: 4,
});

beforeEach(() => {
  document.body.innerHTML = `
    <div data-chat-composer-main-surface="true">
      <div data-testid="composer-editor" contenteditable="true"></div>
    </div>`;
  editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
});

afterEach(() => {
  composerSurface.reset();
  disposeAdapter();
  disposeAdapter = () => {};
  document.body.innerHTML = "";
});

describe("composer undo fence: one history per draft", () => {
  it("composer undo fence spec: type then Escape then u restores the text from before the insert session", () => {
    openDraft("Fix the");
    focusComposer();
    type(" build please");
    press("<Esc>");
    expect(composerSurface.mode()).toBe("normal");

    press("u");

    expect(draft.prompt).toBe("Fix the");
  });

  it("composer undo fence spec: u walks back across three normal-mode sessions in order", () => {
    openDraft("abcdef");
    focusComposer();
    press("<Esc>");
    pressAll("0", "x");
    expect(draft.prompt).toBe("bcdef");
    emptyInsertSession();
    pressAll("$", "x");
    expect(draft.prompt).toBe("bcde");
    emptyInsertSession();
    pressAll("0", "x");
    expect(draft.prompt).toBe("cde");

    press("u");
    expect(draft.prompt).toBe("bcde");
    press("u");
    expect(draft.prompt).toBe("bcdef");
    press("u");
    expect(draft.prompt).toBe("abcdef");
  });

  it("composer undo fence spec: Ctrl+R redoes an undone insert session and a new change clears the redo steps", () => {
    openDraft("");
    focusComposer();
    type("one");
    press("<Esc>");

    press("u");
    expect(draft.prompt).toBe("");
    press("<C-r>");
    expect(draft.prompt).toBe("one");

    press("u");
    expect(draft.prompt).toBe("");
    press("i");
    type("two");
    press("<Esc>");
    expect(draft.prompt).toBe("two");

    press("<C-r>");
    expect(draft.prompt, "the new change cleared the redo step").toBe("two");
    press("u");
    expect(draft.prompt).toBe("");
  });

  it("composer undo fence spec: the cursor after u and Ctrl+R of an insert session is at the start of the changed text", () => {
    openDraft("alpha gamma");
    draft.cursor = "alpha ".length;
    focusComposer();
    type("beta ");
    press("<Esc>");
    press("0");
    expect(composerNormalOffset()).toBe(0);

    press("u");
    expect(draft.prompt).toBe("alpha gamma");
    expect(composerNormalOffset()).toBe(6);
    expect(draft.writes.at(-1)?.cursor).toBe(6);

    press("$");
    press("<C-r>");
    expect(draft.prompt).toBe("alpha beta gamma");
    expect(composerNormalOffset()).toBe(6);
    expect(draft.writes.at(-1)?.cursor).toBe(6);
  });

  it("composer undo fence spec: the cursor after u of an earlier normal-mode session is at the start of the deleted word", () => {
    openDraft("one two three");
    focusComposer();
    press("<Esc>");
    pressAll("0", "w", "d", "w");
    expect(draft.prompt).toBe("one three");
    emptyInsertSession();
    press("$");

    press("u");

    expect(draft.prompt).toBe("one two three");
    expect(composerNormalOffset()).toBe(4);
  });

  it("composer undo fence spec: switching to another thread's draft starts a fresh history", () => {
    openDraft("", "thread-a");
    focusComposer();
    type("alpha");
    press("<Esc>");
    press("x");
    expect(draft.prompt).toBe("alph");

    // The composer moves to thread B: focus leaves, the adapter now reports
    // B's draft, and focus comes back to the composer.
    blurComposer();
    draft.draftKey = freshDraftKey("thread-b");
    draft.prompt = "";
    draft.cursor = 0;
    focusComposer();
    type("beta");
    press("<Esc>");

    press("u");
    expect(draft.prompt).toBe("");
    press("u");
    expect(draft.prompt, "thread A's history never reaches thread B's draft").toBe("");
  });

  it("composer undo fence spec: returning to a thread's draft walks back that draft's own history", () => {
    openDraft("", "thread-a");
    const threadA = draft.draftKey;
    focusComposer();
    type("alpha");
    press("<Esc>");
    press("x");
    expect(draft.prompt).toBe("alph");

    blurComposer();
    draft.draftKey = freshDraftKey("thread-b");
    draft.prompt = "";
    draft.cursor = 0;
    focusComposer();
    type("beta");
    press("<Esc>");

    blurComposer();
    draft.draftKey = threadA;
    draft.prompt = "alph";
    draft.cursor = 4;
    focusComposer();
    press("<Esc>");

    press("u");
    expect(draft.prompt).toBe("alpha");
    press("u");
    expect(draft.prompt).toBe("");
  });

  it("composer undo fence spec: returning to a draft changed elsewhere makes its current text the latest state", () => {
    openDraft("", "thread-a");
    const threadA = draft.draftKey;
    focusComposer();
    type("alpha");
    press("<Esc>");
    blurComposer();

    // Another surface changed thread A's draft while the composer was away.
    draft.draftKey = freshDraftKey("thread-b");
    draft.prompt = "";
    draft.cursor = 0;
    focusComposer();
    blurComposer();
    draft.draftKey = threadA;
    draft.prompt = "alpha beta";
    draft.cursor = 10;
    focusComposer();
    press("<Esc>");

    press("u");
    expect(draft.prompt).toBe("alpha");
    press("u");
    expect(draft.prompt).toBe("");
    press("<C-r>");
    press("<C-r>");
    expect(draft.prompt).toBe("alpha beta");
  });

  it("composer undo fence spec: the palette resume pushes no step and the history survives it", () => {
    openDraft("");
    focusComposer();
    type("alpha");
    press("<Esc>");
    press("x");
    expect(draft.prompt).toBe("alph");

    // The palette opens (focus leaves), then hands focus back with a resume.
    blurComposer();
    resumeComposerNormalOnFocus(3);
    focusComposer();
    expect(composerSurface.mode()).toBe("normal");

    press("u");
    expect(draft.prompt).toBe("alpha");
    press("u");
    expect(draft.prompt).toBe("");
  });
});

describe("composer undo fence: inline tokens", () => {
  it("composer undo fence spec: mentions, citations, skills and context references come back as the same tokens", () => {
    const firstLine = `@AGENTS.md ${citationSource}`;
    const secondLine = `$review ${terminalReference} tail`;
    const prompt = `${firstLine}\n${secondLine}`;
    expect(splitPromptIntoComposerSegments(prompt).map((segment) => segment.type)).toEqual([
      "mention",
      "text",
      "citation",
      "text",
      "skill",
      "text",
      "context-reference",
      "text",
    ]);
    openDraft(prompt);
    focusComposer();
    press("<Esc>");
    pressAll("g", "g", "d", "d");
    expect(draft.prompt).toBe(secondLine);
    emptyInsertSession();
    pressAll("d", "d");
    expect(draft.prompt).toBe("");
    emptyInsertSession();

    press("u");
    expect(draft.prompt).toBe(secondLine);
    press("u");
    expect(draft.prompt).toBe(prompt);
    press("<C-r>");
    expect(draft.prompt).toBe(secondLine);
    press("<C-r>");
    expect(draft.prompt).toBe("");
    press("u");
    press("u");
    expect(draft.prompt).toBe(prompt);
    expect(splitPromptIntoComposerSegments(draft.prompt)).toEqual(
      splitPromptIntoComposerSegments(prompt),
    );
  });

  it("composer undo fence spec: an insert session that typed around tokens undoes to the same tokens", () => {
    const prompt = `@AGENTS.md ${citationSource}`;
    openDraft(prompt);
    focusComposer();
    // Text typed after the two tokens: the collapsed cursor counts each as one.
    draft.prompt = `${prompt} and $review`;
    draft.cursor = 2 + " and $review".length;
    press("<Esc>");

    press("u");
    expect(draft.prompt).toBe(prompt);
    press("<C-r>");
    expect(draft.prompt).toBe(`${prompt} and $review`);
  });
});

describe("composer undo fence: guards", () => {
  it("composer undo fence guard: u inside one normal-mode session undoes the last normal-mode change", () => {
    openDraft("hello world");
    focusComposer();
    press("<Esc>");
    pressAll("0", "d", "w");
    expect(draft.prompt).toBe("world");

    press("u");
    expect(draft.prompt).toBe("hello world");
    press("<C-r>");
    expect(draft.prompt).toBe("world");
  });
});

// Review findings P1-1 to P1-4 and P2-1 on the first implementation.
describe("composer undo fence: review regressions", () => {
  const sendTarget = () =>
    scopeThreadRef(
      EnvironmentId.make("composer-undo-environment"),
      ThreadId.make(freshDraftKey("send-thread")),
    );

  /** Opens a stand-in composer on the draft the store keeps for `target`. */
  function openStoreDraft(target: ReturnType<typeof sendTarget>, prompt: string): void {
    openDraft(prompt);
    draft.draftKey = composerTargetKey(target);
    useComposerDraftStore.getState().setPrompt(target, prompt);
  }

  // P1-1 and P1-2: every send path consumes the draft through the store.
  it("composer undo fence regression: a draft consumed through the store starts a fresh history", () => {
    const target = sendTarget();
    openStoreDraft(target, "");
    focusComposer();
    type("alpha");
    press("<Esc>");
    pressAll("$", "x");
    useComposerDraftStore.getState().setPrompt(target, draft.prompt);

    useComposerDraftStore.getState().clearComposerContent(target);
    draft.prompt = "";
    draft.cursor = 0;
    press("i");
    type("next");
    press("<Esc>");

    press("u");
    expect(draft.prompt).toBe("");
    press("u");
    expect(draft.prompt, "the consumed draft's history is gone").toBe("");
  });

  it("composer undo fence regression: a dictation submission that consumes the draft starts a fresh history", () => {
    const target = sendTarget();
    openStoreDraft(target, "");
    focusComposer();
    type("spoken");
    press("<Esc>");
    useComposerDraftStore.getState().setPrompt(target, draft.prompt);

    consumeDirectedComposerDraft(target, null);
    draft.prompt = "";
    draft.cursor = 0;
    press("i");
    type("typed");
    press("<Esc>");

    press("u");
    press("u");
    expect(draft.prompt).toBe("");
  });

  it("composer undo fence regression: a failed send that restores the draft brings its history back", () => {
    const target = sendTarget();
    openStoreDraft(target, "");
    focusComposer();
    type("alpha");
    press("<Esc>");
    pressAll("$", "x");
    useComposerDraftStore.getState().setPrompt(target, draft.prompt);

    useComposerDraftStore.getState().clearComposerContent(target);
    // The send failed and put the draft back.
    useComposerDraftStore.getState().setPrompt(target, "alph");

    press("u");
    expect(draft.prompt).toBe("alpha");
    press("u");
    expect(draft.prompt).toBe("");
  });

  // P1-3: the change starts at the selection's start, not at its end.
  it("composer undo fence regression: u after a visual delete in repeated text puts the cursor at the selection start", () => {
    openDraft("aaaaa");
    focusComposer();
    press("<Esc>");
    pressAll("0", "v", "l", "l", "d");
    expect(draft.prompt).toBe("aa");
    press("$");

    press("u");
    expect(draft.prompt).toBe("aaaaa");
    expect(composerNormalOffset()).toBe(0);
  });

  it("composer undo fence regression: u after a backward delete in repeated text puts the cursor where the deleted text was", () => {
    openDraft("aaaaa");
    focusComposer();
    press("<Esc>");
    pressAll("$", "d", "h");
    expect(draft.prompt).toBe("aaaa");
    press("0");

    press("u");
    expect(draft.prompt).toBe("aaaaa");
    expect(composerNormalOffset()).toBe(3);
  });

  // P1-4: an empty insert session keeps the redo cursor.
  it("composer undo fence regression: an empty insert session after u keeps where Ctrl+R puts the cursor", () => {
    openDraft("aaaa");
    focusComposer();
    press("<Esc>");
    pressAll("0", "l", "l", "x");
    expect(draft.prompt).toBe("aaa");
    press("u");
    press("0");
    emptyInsertSession();

    press("<C-r>");
    expect(draft.prompt).toBe("aaa");
    expect(composerNormalOffset()).toBe(2);
  });

  // P2-1: the composer's history is the only one, and it is bounded.
  it("composer undo fence regression: the session buffer keeps no undo snapshots of its own", () => {
    const buffer = new ComposerTextBuffer("abc");
    for (let step = 0; step < 500; step += 1) {
      buffer.saveUndoPoint({ line: 0, col: 0 });
      buffer.insertAt(0, 0, "x");
    }
    expect(buffer.undo({ line: 0, col: 0 })).toBeNull();
  });

  it("composer undo fence regression: a draft's history keeps at most 200 states", () => {
    const draftKey = freshDraftKey("bound");
    for (let step = 0; step <= 300; step += 1) recordComposerUndoState(draftKey, `${step}`, 0);
    let prompt = "300";
    let steps = 0;
    for (let next = undoComposerChange(draftKey, prompt, 0); next;) {
      prompt = next.prompt;
      steps += 1;
      next = undoComposerChange(draftKey, prompt, 0);
    }
    expect(steps).toBe(199);
    expect(prompt).toBe("101");
  });
});
