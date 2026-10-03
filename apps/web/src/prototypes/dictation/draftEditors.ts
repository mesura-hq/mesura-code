/**
 * One Lexical editor per prototype thread, all mounted at once, so a
 * transcription can land in a draft the user is not looking at. The real
 * composer mounts one editor; there the same operations would rewrite the
 * persisted prompt string instead.
 */
import {
  $createParagraphNode,
  $createRangeSelectionFromDom,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  type EditorUpdateOptions,
  type LexicalEditor,
  type LexicalNode,
  SKIP_DOM_SELECTION_TAG,
} from "lexical";

import { DictationSlotNode } from "./DictationSlotNode";

const editorsByThreadId = new Map<string, LexicalEditor>();

export function registerDraftEditor(threadId: string, editor: LexicalEditor): () => void {
  editorsByThreadId.set(threadId, editor);
  return () => {
    if (editorsByThreadId.get(threadId) === editor) editorsByThreadId.delete(threadId);
  };
}

function collectSlots(node: LexicalNode, into: DictationSlotNode[]): DictationSlotNode[] {
  if (node instanceof DictationSlotNode) into.push(node);
  if ($isElementNode(node)) for (const child of node.getChildren()) collectSlots(child, into);
  return into;
}

function findSlot(jobId: string): DictationSlotNode | null {
  return collectSlots($getRoot(), []).find((slot) => slot.getJobId() === jobId) ?? null;
}

/**
 * Discrete, so the next read (slot count, draft text) sees this edit. Edits to
 * a draft without focus skip the DOM selection, or they would pull the caret,
 * and the focus, into a draft the user is not typing in.
 */
function updateOptions(editor: LexicalEditor): EditorUpdateOptions {
  const root = editor.getRootElement();
  const focused = root !== null && root.contains(document.activeElement);
  return focused ? { discrete: true } : { discrete: true, tag: SKIP_DOM_SELECTION_TAG };
}

export function insertDictationSlotAtCaret(threadId: string, jobId: string) {
  const editor = editorsByThreadId.get(threadId);
  if (!editor) return;
  editor.update(() => {
    // Lexical syncs its selection from the DOM on the async selectionchange
    // event, so a key pressed right after arrow keys sees a stale caret. Read
    // the DOM caret directly while the editor has focus.
    const root = editor.getRootElement();
    const domSelection =
      root !== null && root.contains(document.activeElement) ? window.getSelection() : null;
    let selection = domSelection
      ? ($createRangeSelectionFromDom(domSelection, editor) ?? $getSelection())
      : $getSelection();
    if (!$isRangeSelection(selection)) {
      $getRoot().selectEnd();
      selection = $getSelection();
    }
    if ($isRangeSelection(selection)) {
      $setSelection(selection);
      selection.insertNodes([new DictationSlotNode(jobId)]);
    }
  }, updateOptions(editor));
}

const NO_SPACE_BEFORE = /^[\s.,;:!?)]/;

/** Replaces a slot with its transcript. Returns false when the user deleted the slot. */
export function fillDictationSlot(threadId: string, jobId: string, text: string): boolean {
  const editor = editorsByThreadId.get(threadId);
  if (!editor) return false;
  let filled = false;
  editor.update(() => {
    const slot = findSlot(jobId);
    if (!slot) return;
    const previous = slot.getPreviousSibling();
    const next = slot.getNextSibling();
    const previousText = $isTextNode(previous) ? previous.getTextContent() : "";
    const nextText = $isTextNode(next) ? next.getTextContent() : "";
    const leading = previousText.length > 0 && !/\s$/.test(previousText) ? " " : "";
    const trailing = nextText.length > 0 && !NO_SPACE_BEFORE.test(nextText) ? " " : "";
    slot.replace($createTextNode(`${leading}${text}${trailing}`));
    filled = true;
  }, updateOptions(editor));
  return filled;
}

export function removeDictationSlot(threadId: string, jobId: string) {
  const editor = editorsByThreadId.get(threadId);
  editor?.update(() => findSlot(jobId)?.remove(), updateOptions(editor));
}

export function countDictationSlots(threadId: string): number {
  const editor = editorsByThreadId.get(threadId);
  if (!editor) return 0;
  return editor.getEditorState().read(() => collectSlots($getRoot(), []).length);
}

export function readDraftText(threadId: string): string {
  const editor = editorsByThreadId.get(threadId);
  if (!editor) return "";
  return editor.getEditorState().read(() => $getRoot().getTextContent());
}

export function clearDraft(threadId: string) {
  const editor = editorsByThreadId.get(threadId);
  editor?.update(() => {
    $getRoot().clear().append($createParagraphNode());
  }, updateOptions(editor));
}
