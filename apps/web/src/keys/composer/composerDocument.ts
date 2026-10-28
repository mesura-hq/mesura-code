import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";

/**
 * The composer as Vim reads it: the shown text, one line per textblock line, from the ProseMirror
 * document, not its Markdown, so list markers, fences and checkboxes are structure, not text.
 * Inside a line every text character and inline atom takes one position: offsets map by addition.
 */

export interface ComposerDocLine {
  /** Offset of the line's first character in `text`. */
  readonly start: number;
  readonly length: number;
  /** ProseMirror position of the line's first character. */
  readonly pmStart: number;
  /** A horizontal rule is a line of one object character covering the node. */
  readonly kind: "text" | "rule";
  /** Position of the block that owns the line, and whether it owns only this line. */
  readonly blockPos: number;
  readonly wholeBlock: boolean;
}

export interface ComposerDocSnapshot {
  readonly doc: ProseMirrorNode;
  readonly text: string;
  readonly lines: readonly ComposerDocLine[];
}

const RULE_CHARACTER = String.fromCharCode(0xfffc);
const ATOM_FIRST = 0xe000;
const ATOM_LAST = 0xf8ff;

/**
 * Each inline atom (mention, skill, citation, context reference) is one private-use character,
 * the same one until the table resets (`atomCharacterEpoch`), so a register keeps its meaning
 * after the document that produced it is gone: a paste after undo/redo restores the real node.
 */
const atomCharacterByKey = new Map<string, string>();
const atomJsonByCharacter = new Map<string, unknown>();
/** Room kept free so one document never runs the table out while it is being read. */
const ATOM_HEADROOM = 512;
let atomEpoch = 0;

/**
 * Bumped when the character table is reset. A character saved under an older epoch (a register)
 * may name another node now, so its holder must drop it rather than paste it.
 */
export function atomCharacterEpoch(): number {
  return atomEpoch;
}

function resetAtomCharactersIfFull(): void {
  if (atomCharacterByKey.size <= ATOM_LAST - ATOM_FIRST - ATOM_HEADROOM) return;
  atomCharacterByKey.clear();
  atomJsonByCharacter.clear();
  atomEpoch += 1;
}

function atomCharacter(node: ProseMirrorNode): string {
  const json = node.toJSON() as unknown;
  const key = JSON.stringify(json);
  let character = atomCharacterByKey.get(key);
  if (character === undefined) {
    character = String.fromCharCode(ATOM_FIRST + atomCharacterByKey.size);
    atomCharacterByKey.set(key, character);
    atomJsonByCharacter.set(character, json);
  }
  return character;
}

export function isObjectCharacter(character: string): boolean {
  return character === RULE_CHARACTER || atomJsonByCharacter.has(character);
}

export function snapshotComposerDoc(doc: ProseMirrorNode): ComposerDocSnapshot {
  resetAtomCharactersIfFull();
  const lines: ComposerDocLine[] = [];
  let text = "";
  const pushLine = (
    content: string,
    pmStart: number,
    kind: ComposerDocLine["kind"],
    blockPos: number,
    wholeBlock: boolean,
  ) => {
    if (lines.length > 0) text += "\n";
    lines.push({ start: text.length, length: content.length, pmStart, kind, blockPos, wholeBlock });
    text += content;
  };

  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      const blockLines: Array<{ content: string; pmStart: number }> = [];
      let content = "";
      let lineStart = pos + 1;
      node.forEach((child, childOffset) => {
        const childPos = pos + 1 + childOffset;
        if (child.isText) {
          const parts = child.text!.split("\n");
          let partPos = childPos;
          parts.forEach((part, index) => {
            if (index > 0) {
              blockLines.push({ content, pmStart: lineStart });
              content = "";
              lineStart = partPos;
            }
            content += part;
            // One position for the part, one for the newline that ends it.
            partPos += part.length + 1;
          });
        } else if (child.type.name === "hardBreak") {
          blockLines.push({ content, pmStart: lineStart });
          content = "";
          lineStart = childPos + 1;
        } else {
          content += atomCharacter(child);
        }
      });
      blockLines.push({ content, pmStart: lineStart });
      const wholeBlock = blockLines.length === 1;
      for (const line of blockLines) pushLine(line.content, line.pmStart, "text", pos, wholeBlock);
      return false;
    }
    if (node.isBlock && node.isLeaf) {
      pushLine(RULE_CHARACTER, pos, "rule", pos, true);
      return false;
    }
    return true;
  });
  if (lines.length === 0)
    lines.push({ start: 0, length: 0, pmStart: 1, kind: "text", blockPos: 0, wholeBlock: true });
  return { doc, text, lines };
}

export function lineIndexAt(snapshot: ComposerDocSnapshot, offset: number): number {
  const { lines } = snapshot;
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lines[middle]!.start <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** The ProseMirror position before the character at `offset`; a line's end maps to its content end. */
export function pmPositionAt(snapshot: ComposerDocSnapshot, offset: number): number {
  const line = snapshot.lines[lineIndexAt(snapshot, offset)]!;
  return line.pmStart + Math.max(0, Math.min(offset - line.start, line.length));
}

/** The offset of a ProseMirror position: inside a line, or the start of the next line after it. */
export function offsetAtPmPosition(snapshot: ComposerDocSnapshot, position: number): number {
  for (const line of snapshot.lines) {
    if (position < line.pmStart) return line.start;
    if (position <= line.pmStart + line.length) return line.start + (position - line.pmStart);
  }
  const last = snapshot.lines.at(-1)!;
  return last.start + last.length;
}

/** The ProseMirror ranges of `[from, to)`, one per line, never crossing a block boundary. */
export function pmRangesBetween(
  snapshot: ComposerDocSnapshot,
  from: number,
  to: number,
): Array<{ readonly from: number; readonly to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  for (const line of snapshot.lines) {
    const start = Math.max(from, line.start);
    const end = Math.min(to, line.start + line.length);
    if (end <= start) continue;
    ranges.push({ from: line.pmStart + start - line.start, to: line.pmStart + end - line.start });
  }
  return ranges;
}

/** The inline nodes `text` stands for: text runs carrying `marks`, atoms as their own nodes. */
export function inlineNodesFor(
  text: string,
  schema: Schema,
  marks: Parameters<Schema["text"]>[1],
): ProseMirrorNode[] {
  const nodes: ProseMirrorNode[] = [];
  let run = "";
  const flush = () => {
    if (run.length > 0) nodes.push(schema.text(run, marks));
    run = "";
  };
  for (const character of text) {
    const json = atomJsonByCharacter.get(character);
    if (json === undefined) {
      if (character !== RULE_CHARACTER) run += character;
      continue;
    }
    flush();
    nodes.push(schema.nodeFromJSON(json));
  }
  flush();
  return nodes;
}
