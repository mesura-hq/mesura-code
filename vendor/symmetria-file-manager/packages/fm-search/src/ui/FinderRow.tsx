/**
 * One result: the name, the directory it sits in, and what the query matched.
 *
 * **The matched positions index the RELATIVE PATH, not the name.** The engine
 * gives no per-character positions for a file result, so they are recomputed
 * over the relative path — which is what the user was matching against when
 * they typed `src/fmt`. Marking only inside the name would leave a query that
 * matched purely in the directory with no marks at all, which reads as a row
 * that should not be there.
 *
 * So the path is split once, at the boundary between the directory part and the
 * name, and each half is marked with the positions that fall inside it. The
 * halves differ only in weight: the name is foreground, the directory is dim.
 */
import type { SearchReplyRow } from "@symmetria/fm-core/contract";

import { FileIcon } from "./FileIcon.tsx";

/** A run of characters, either matched by the query or not. */
interface Segment {
  readonly text: string;
  readonly matched: boolean;
}

/**
 * `text` cut into alternating matched and unmatched runs.
 *
 * Positions outside the string are ignored rather than rejected: they can only
 * arrive from a row whose name and relative path disagree, and dropping a mark
 * is a better failure than dropping the row.
 */
function markedSegments(text: string, positions: readonly number[]): readonly Segment[] {
  const marked = new Set(positions.filter((at) => at >= 0 && at < text.length));
  const segments: Segment[] = [];

  for (const [at, character] of [...text].entries()) {
    const matched = marked.has(at);
    const last = segments.at(-1);
    // Extended rather than appended, so a run of five matched characters is one
    // element and one element of the DOM, not five.
    if (last !== undefined && last.matched === matched) {
      segments[segments.length - 1] = { text: last.text + character, matched };
    } else {
      segments.push({ text: character, matched });
    }
  }
  return segments;
}

/**
 * Where the display name starts inside the relative path.
 *
 * Computed from the two lengths rather than by searching for the name, because
 * a name that also appears earlier in its own path — `src/test/test.ts` — would
 * make a search find the wrong occurrence. A directory row's relative path
 * carries a trailing separator that its name does not, and that is the only
 * reason this is not simply a subtraction.
 */
function nameStartsAt(relativePath: string, name: string): number {
  const bare = relativePath.endsWith("/") ? relativePath.slice(0, -1) : relativePath;
  return Math.max(bare.length - name.length, 0);
}

/** `text`, with the query's matched runs marked. */
function MarkedText({
  text,
  positions,
}: {
  readonly text: string;
  readonly positions: readonly number[];
}) {
  return (
    <>
      {/* A segment has no identity beyond its position in this one string, and
          the string is rebuilt whenever it changes — so the index IS the key.
          Each suppression below is ONE line: biome attaches an ignore to
          whatever follows it, and a continuation comment silently detaches it. */}
      {markedSegments(text, positions).map((segment, at) =>
        segment.matched ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a segment's identity IS its position
          <mark key={at} className="finder__match">
            {segment.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: a segment's identity IS its position
          <span key={at}>{segment.text}</span>
        ),
      )}
    </>
  );
}

export interface FinderRowProps {
  readonly row: SearchReplyRow;
  readonly id: string;
  readonly active: boolean;
}

export function FinderRow({ row, id, active }: FinderRowProps) {
  const start = nameStartsAt(row.relativePath, row.name);
  const directory = row.relativePath.slice(0, start);
  const name = row.relativePath.slice(start, start + row.name.length);

  const inDirectory = row.matchIndices.filter((at) => at < start);
  const inName = row.matchIndices.filter((at) => at >= start).map((at) => at - start);

  // Focus stays in the query field, which names the current row with
  // `aria-activedescendant`. A tabIndex per row would put every result in the
  // tab order and break the very pattern these roles declare. The suppression
  // below is one line directly above the element, for the reason stated in
  // `MarkedText`: a continuation comment detaches it.
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: focus belongs to the query field
    <div
      id={id}
      data-testid="finder-row"
      role="option"
      aria-selected={active}
      data-active={active ? "true" : undefined}
      className={`overlay__row finder__row${active ? " overlay__row--active" : ""}`}
    >
      {/* The SAME component the pane's rows and the directory preview draw, so
          a `.ts` looks like a `.ts` everywhere and there is one place to change
          it — `@symmetria/fm-core/icons/resolve` names the symbol, this draws
          it. The row carries no MIME type, which is why `FileIcon` resolves the
          chrome symbols from the name as well. */}
      <FileIcon name={row.name} kind={row.isDir ? "directory" : "file"} />
      <span className="finder__name" data-testid="finder-row-name">
        <MarkedText text={name} positions={inName} />
      </span>
      {directory === "" ? null : (
        <span className="finder__directory" data-testid="finder-row-directory">
          <MarkedText text={directory} positions={inDirectory} />
        </span>
      )}
    </div>
  );
}
