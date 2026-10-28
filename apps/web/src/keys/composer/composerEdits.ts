import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";

import { splitOrLiftListItem } from "~/composer-rich-text-doc";

import {
  inlineNodesFor,
  lineIndexAt,
  pmPositionAt,
  snapshotComposerDoc,
  type ComposerDocSnapshot,
} from "./composerDocument";

/**
 * Applies a Vim edit (buffer text before and after) as editor transactions on the one differing
 * span. A deleted line break joins blocks as Backspace does and an inserted one splits them as
 * Enter does, so list items stay items and code stays code. A linewise delete removes whole blocks.
 */
export function applyComposerTextChange(
  editor: Editor,
  snapshot: ComposerDocSnapshot,
  after: string,
  edit: ComposerEditAnchor,
): ComposerDocSnapshot {
  const { from, to, inserted } = locateChange(snapshot.text, after, edit);
  if (edit.linewise && inserted.length === 0 && deleteWholeLines(editor, snapshot, from, to)) {
    return snapshotComposerDoc(editor.state.doc);
  }
  replaceSpan(editor, snapshot, from, to, inserted);
  return snapshotComposerDoc(editor.state.doc);
}

/** Where the Vim operation acted, which picks among equal-looking edits in repeated text. */
export interface ComposerEditAnchor {
  /** Where a deletion starts: the leftmost of the cursor and the selection (a line start when linewise). */
  readonly start: number;
  /** The cursor after the edit, which a paste leaves inside the text it inserted. */
  readonly cursorAfter: number;
  readonly linewise: boolean;
}

/**
 * The span `before` → `after` replaced. A pure insertion or deletion inside repeated text can sit
 * at several offsets with the same resulting text (`same\nsame` minus one line); those are
 * different edits once blocks or marks differ, so the operation's anchor chooses the offset.
 */
export function locateChange(
  before: string,
  after: string,
  edit: ComposerEditAnchor,
): { from: number; to: number; inserted: string } {
  let prefix = 0;
  const shorter = Math.min(before.length, after.length);
  while (prefix < shorter && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = before.length - suffix - prefix;
  const added = after.length - suffix - prefix;
  if (removed > 0 && added > 0) {
    return {
      from: prefix,
      to: before.length - suffix,
      inserted: after.slice(prefix, after.length - suffix),
    };
  }
  // The same text inserted or removed at `start` gives the same result for every start in
  // [earliest, prefix]: each shift left moves one equal character from before the span to after it.
  const longer = removed > 0 ? before : after;
  const length = removed + added;
  let earliest = prefix;
  while (earliest > 0 && longer[earliest - 1] === longer[earliest - 1 + length]) earliest -= 1;
  // A paste leaves the cursor on the last character it inserted.
  const wanted = removed > 0 ? edit.start : edit.cursorAfter - length + 1;
  const start = Math.max(earliest, Math.min(prefix, wanted));
  return removed > 0
    ? { from: start, to: start + length, inserted: "" }
    : { from: start, to: start, inserted: after.slice(start, start + length) };
}

function replaceSpan(
  editor: Editor,
  snapshot: ComposerDocSnapshot,
  from: number,
  to: number,
  inserted: string,
): void {
  const { schema } = editor.state;
  const fromPm = pmPositionAt(snapshot, from);
  const toPm = pmPositionAt(snapshot, to);
  const deletedNode = to > from ? snapshot.doc.nodeAt(fromPm) : null;
  // Replacing text keeps its formatting: the marks of the first replaced character win.
  const marks = deletedNode?.isText ? deletedNode.marks : snapshot.doc.resolve(fromPm).marks();
  const [first = "", ...rest] = inserted.split("\n");

  const tr = editor.state.tr;
  if (toPm > fromPm) tr.delete(fromPm, toPm);
  let position = fromPm;
  const firstNodes = inlineNodesFor(first, schema, marks);
  if (firstNodes.length > 0) {
    tr.insert(position, firstNodes);
    position += firstNodes.reduce((size, node) => size + node.nodeSize, 0);
  }
  tr.setSelection(TextSelection.create(tr.doc, position));
  editor.view.dispatch(tr);

  for (const part of rest) {
    splitLineAtSelection(editor);
    const nodes = inlineNodesFor(part, schema, editor.state.selection.$from.marks());
    if (nodes.length > 0)
      editor.view.dispatch(editor.state.tr.insert(editor.state.selection.from, nodes));
  }
}

/** A line break typed at the caret: a newline in code, a sibling item in a list, a new block elsewhere. */
function splitLineAtSelection(editor: Editor): void {
  const { $from } = editor.state.selection;
  if ($from.parent.type.spec.code === true) {
    editor.view.dispatch(editor.state.tr.insertText("\n"));
    return;
  }
  if (splitOrLiftListItem(editor)) return;
  editor.commands.splitBlock();
}

/**
 * Deletes the lines in `[from, to)` as blocks when the span is exactly whole lines and each line
 * is a whole block. False when the span is not whole blocks: the caller then edits it as text.
 */
function deleteWholeLines(
  editor: Editor,
  snapshot: ComposerDocSnapshot,
  from: number,
  to: number,
): boolean {
  const { lines, text, doc } = snapshot;
  let first: number;
  let last: number;
  if (from === 0 && to === text.length) {
    first = 0;
    last = lines.length - 1;
  } else if (text[to - 1] === "\n" && lines[lineIndexAt(snapshot, from)]!.start === from) {
    first = lineIndexAt(snapshot, from);
    last = lineIndexAt(snapshot, to) - 1;
  } else if (text[from] === "\n" && to === text.length) {
    first = lineIndexAt(snapshot, from + 1);
    last = lines.length - 1;
  } else {
    return false;
  }
  if (first === 0 && last === lines.length - 1) {
    const tr = editor.state.tr.replaceWith(
      0,
      doc.content.size,
      editor.state.schema.nodes.paragraph!.create(),
    );
    editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, 1)));
    return true;
  }
  for (let index = first; index <= last; index += 1) {
    if (!lines[index]!.wholeBlock) return false;
  }
  const startPos = lines[first]!.blockPos;
  const lastBlock = lines[last]!.blockPos;
  const endPos = lastBlock + doc.nodeAt(lastBlock)!.nodeSize;
  // deleteRange widens to each parent it covers whole: the last item takes its list along.
  const tr = editor.state.tr.deleteRange(startPos, endPos);
  const next = Math.min(tr.mapping.map(startPos), tr.doc.content.size);
  tr.setSelection(TextSelection.near(tr.doc.resolve(next)));
  editor.view.dispatch(tr);
  return true;
}
